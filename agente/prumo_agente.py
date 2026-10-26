# -*- coding: utf-8 -*-
"""
Agente Prumo — robô do escritório.

Fica rodando num computador do escritório (Windows), pergunta ao Prumo se há
tarefa, executa (hoje: emitir NFA-e na Receita-PR) e devolve o resultado.

Segurança:
  * a conexão sai daqui para o Prumo (nada fica aberto no escritório);
  * a chave da máquina e as senhas da Receita-PR ficam protegidas pelo Windows
    (DPAPI) só neste computador — as senhas nunca vão para o Prumo;
  * o agente só executa os tipos de tarefa programados aqui; nunca roda
    comandos vindos da internet.
"""
import base64
import ctypes
import datetime as dt
import json
import os
import platform
import queue
import re
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request

VERSAO = "1.0.0"
NO_WINDOWS = platform.system() == "Windows"
PASTA = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "PrumoRobo") if NO_WINDOWS else os.path.join(os.path.expanduser("~"), ".prumo-robo")
os.makedirs(PASTA, exist_ok=True)
ARQ_CONFIG = os.path.join(PASTA, "config.json")
ARQ_SENHAS = os.path.join(PASTA, "senhas.json")
ARQ_SELETORES = os.path.join(PASTA, "seletores.json")
ARQ_LOG = os.path.join(PASTA, "robo.log")
SIMULAR = os.environ.get("PRUMO_SIMULAR") == "1"

# ---------------------------------------------------------------------------
# Registro (log) — arquivo + janela
# ---------------------------------------------------------------------------
_fila_log = queue.Queue()


def log(msg):
    linha = f"{dt.datetime.now():%d/%m %H:%M:%S}  {msg}"
    print(linha, flush=True)
    try:
        if os.path.exists(ARQ_LOG) and os.path.getsize(ARQ_LOG) > 2_000_000:
            os.replace(ARQ_LOG, ARQ_LOG + ".1")
        with open(ARQ_LOG, "a", encoding="utf-8") as f:
            f.write(linha + "\n")
    except OSError:
        pass
    _fila_log.put(linha)


# ---------------------------------------------------------------------------
# Proteção de segredos (DPAPI do Windows: só este usuário, neste computador, abre)
# ---------------------------------------------------------------------------
class _Blob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _dpapi(dados: bytes, proteger: bool) -> bytes:
    crypt32, kernel32 = ctypes.windll.crypt32, ctypes.windll.kernel32
    entrada = _Blob(len(dados), ctypes.cast(ctypes.create_string_buffer(dados, len(dados)), ctypes.POINTER(ctypes.c_char)))
    saida = _Blob()
    entropia = b"PrumoRobo-v1"
    ent = _Blob(len(entropia), ctypes.cast(ctypes.create_string_buffer(entropia, len(entropia)), ctypes.POINTER(ctypes.c_char)))
    fn = crypt32.CryptProtectData if proteger else crypt32.CryptUnprotectData
    args = (ctypes.byref(entrada), "PrumoRobo" if proteger else None, ctypes.byref(ent), None, None, 0x1, ctypes.byref(saida)) if proteger \
        else (ctypes.byref(entrada), None, ctypes.byref(ent), None, None, 0x1, ctypes.byref(saida))
    if not fn(*args):
        raise OSError("Não consegui " + ("proteger" if proteger else "abrir") + " o segredo (DPAPI).")
    try:
        return ctypes.string_at(saida.pbData, saida.cbData)
    finally:
        kernel32.LocalFree(saida.pbData)


def proteger(texto: str) -> str:
    dados = texto.encode("utf-8")
    if NO_WINDOWS:
        return "dpapi:" + base64.b64encode(_dpapi(dados, True)).decode()
    return "b64:" + base64.b64encode(dados).decode()  # só para testes fora do Windows


def abrir(guardado: str) -> str:
    if guardado.startswith("dpapi:"):
        return _dpapi(base64.b64decode(guardado[6:]), False).decode("utf-8")
    if guardado.startswith("b64:"):
        return base64.b64decode(guardado[4:]).decode("utf-8")
    raise ValueError("Segredo em formato desconhecido.")


def ler_json(caminho, padrao):
    try:
        with open(caminho, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return padrao


def gravar_json(caminho, dados):
    tmp = caminho + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(dados, f, ensure_ascii=False, indent=2)
    os.replace(tmp, caminho)


# ---------------------------------------------------------------------------
# Conversa com o Prumo
# ---------------------------------------------------------------------------
class Desvinculado(Exception):
    pass


class Prumo:
    def __init__(self):
        self.cfg = ler_json(ARQ_CONFIG, {})

    @property
    def vinculado(self):
        return bool(self.cfg.get("url") and self.cfg.get("token"))

    def _pedir(self, caminho, corpo=None, token=True, timeout=60):
        url = self.cfg["url"].rstrip("/") + caminho
        dados = json.dumps(corpo or {}).encode()
        req = urllib.request.Request(url, data=dados, method="POST", headers={"Content-Type": "application/json", "User-Agent": f"AgentePrumo/{VERSAO}"})
        if token:
            req.add_header("Authorization", "Bearer " + abrir(self.cfg["token"]))
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            try:
                resposta = json.loads(e.read().decode("utf-8"))
            except ValueError:
                resposta = {}
            if e.code == 401 and resposta.get("desvinculado"):
                raise Desvinculado(resposta.get("erro") or "Computador desvinculado.")
            raise RuntimeError(resposta.get("erro") or f"HTTP {e.code}")

    def vincular(self, url, codigo, nome):
        url = url.strip().rstrip("/")
        if not url.startswith("https://") and not url.startswith("http://localhost"):
            raise ValueError("O endereço do Prumo precisa começar com https://")
        self.cfg = {"url": url}
        r = self._pedir("/api/robo/vincular", {"codigo": codigo, "nome": nome}, token=False)
        self.cfg = {"url": url, "token": proteger(r["token"]), "nome": nome, "roboId": r["robo"]["id"], "vinculadoEm": dt.datetime.now().isoformat()}
        gravar_json(ARQ_CONFIG, self.cfg)
        return r["robo"]

    def desvincular_local(self):
        self.cfg = {}
        try:
            os.remove(ARQ_CONFIG)
        except OSError:
            pass

    def ciclo(self, senhas_ids, livre=True, quer_emitentes=False):
        return self._pedir("/api/robo/ciclo", {"emitentesComSenha": senhas_ids, "versao": VERSAO, "livre": livre, "querEmitentes": quer_emitentes})

    def resultado(self, tarefa_id, status, mensagem, numero=None, arquivos=()):
        anexos = []
        for caminho in arquivos:
            try:
                with open(caminho, "rb") as f:
                    conteudo = f.read()
                if len(conteudo) > 10_000_000:
                    continue
                nome = os.path.basename(caminho)
                tipo = {".pdf": "application/pdf", ".png": "image/png", ".xml": "application/xml", ".html": "text/html"}.get(os.path.splitext(nome)[1].lower(), "application/octet-stream")
                anexos.append({"nome": nome, "tipo": tipo, "base64": base64.b64encode(conteudo).decode()})
            except OSError:
                pass
        return self._pedir("/api/robo/resultado", {"tarefaId": tarefa_id, "status": status, "mensagem": mensagem, "numeroNota": numero, "arquivos": anexos}, timeout=120)


# ---------------------------------------------------------------------------
# Senhas dos emitentes (Receita-PR) — só aqui, protegidas pelo Windows
# ---------------------------------------------------------------------------
def senhas_guardadas():
    return ler_json(ARQ_SENHAS, {})


def guardar_senha(emitente_id, senha):
    s = senhas_guardadas()
    if senha:
        s[emitente_id] = proteger(senha)
    else:
        s.pop(emitente_id, None)
    gravar_json(ARQ_SENHAS, s)


def senha_de(emitente_id):
    g = senhas_guardadas().get(emitente_id)
    return abrir(g) if g else None


# ---------------------------------------------------------------------------
# Robô da NFA-e (Receita-PR) — roteiro do aplicativo antigo, com seletores
# guardados em seletores.json (dá para ajustar sem mexer no código) e
# "aprendizado" da parte final (transmitir/baixar) na primeira emissão.
# ---------------------------------------------------------------------------
SELETORES_PADRAO = {
    "url_login": "https://receita.pr.gov.br/",
    "url_emissao": "https://nfae.fazenda.pr.gov.br/nfae/avulsa/emitir/emitente",
    "login_usuario": "input[type='text'], input[name='username']",
    "login_senha": "input[type='password']",
    "login_botao": "//button[contains(text(), 'Entrar') or contains(text(), 'Login')]",
    "botao_avancar": "//button[contains(., 'Avançar') or contains(., 'Continuar')]",
    "destinatario": {
        "cnpj": "/html/body/div[1]/div[2]/div[2]/div[5]/div/div[1]/div/div[2]/div[1]/div[1]/div[2]/div[3]/div[1]/input",
        "ie": "/html/body/div[1]/div[2]/div[2]/div[5]/div/div[1]/div/div[2]/div[1]/div[1]/div[2]/div[7]/div[1]/input",
        "nome": "/html/body/div[1]/div[2]/div[2]/div[5]/div/div[1]/div/div[2]/div[1]/div[1]/div[2]/div[8]/div[1]/input",
        "cep": "/html/body/div[1]/div[2]/div[2]/div[5]/div/div[1]/div/div[2]/div[1]/div[2]/div[2]/div[2]/div[1]/input",
        "logradouro": "/html/body/div[1]/div[2]/div[2]/div[5]/div/div[1]/div/div[2]/div[1]/div[2]/div[2]/div[3]/div[1]/input",
        "numero": "/html/body/div[1]/div[2]/div[2]/div[5]/div/div[1]/div/div[2]/div[1]/div[2]/div[2]/div[4]/div[1]/input",
        "bairro": "/html/body/div[1]/div[2]/div[2]/div[5]/div/div[1]/div/div[2]/div[1]/div[2]/div[2]/div[8]/div[1]/input",
    },
    "operacao": {
        "natureza_combo": "//*[@id=\"combobox-id-1\"]",
        "natureza_valor": "Venda",
        "selects": [
            ["/html/body/div/div[2]/div[2]/div[5]/div/div[1]/div/div[2]/div[1]/div/div[2]/div[2]/div[1]/div/select", "1 - Saída"],
            ["/html/body/div/div[2]/div[2]/div[5]/div/div[1]/div/div[2]/div[1]/div/div[2]/div[4]/div[1]/div/select", "1 - NF-e normal"],
            ["/html/body/div/div[2]/div[2]/div[5]/div/div[1]/div/div[2]/div[1]/div/div[2]/div[5]/div[1]/div/select", "0 - Não se aplica"],
        ],
    },
    "produto": {
        "codigo": "/html/body/div/div[2]/div[2]/div[5]/div/div[1]/div/div[2]/div/div/div/div/div[2]/div[2]/div[1]/input",
        "descricao": "/html/body/div/div[2]/div[2]/div[5]/div/div[1]/div/div[2]/div/div/div/div/div[2]/div[1]/div[1]/input",
        "ncm": "/html/body/div/div[2]/div[2]/div[5]/div/div[1]/div/div[2]/div/div/div/div/div[2]/div[3]/div[2]/input",
        "cfop": "/html/body/div/div[2]/div[2]/div[5]/div/div[1]/div/div[2]/div/div/div/div/div[2]/div[5]/div[1]/div/select",
        "unidade": "/html/body/div/div[2]/div[2]/div[5]/div/div[1]/div/div[2]/div/div/div/div/div[2]/div[6]/div[2]/input",
        "qtd": "/html/body/div/div[2]/div[2]/div[5]/div/div[1]/div/div[2]/div/div/div/div/div[2]/div[7]/div[1]/input",
        "valor": "/html/body/div/div[2]/div[2]/div[5]/div/div[1]/div/div[2]/div/div/div/div/div[2]/div[8]/div[1]/input",
        "botao_adicionar": "//button[contains(., 'Adicionar Produto') or contains(., 'adicionar produto')]",
    },
    # Preenchido sozinho na primeira emissão (modo aprendizado): o que você
    # fizer depois que o robô lançar os produtos (completar campos, transmitir,
    # baixar o PDF) vira passo automático para as próximas.
    "finalizacao": [],
}


def seletores():
    s = ler_json(ARQ_SELETORES, None)
    if not s:
        gravar_json(ARQ_SELETORES, SELETORES_PADRAO)
        return json.loads(json.dumps(SELETORES_PADRAO))
    for k, v in SELETORES_PADRAO.items():
        s.setdefault(k, v)
    return s


GRAVADOR_JS = r"""
// Grava cliques e campos alterados. Guarda no sessionStorage NA HORA, porque o clique
// que troca de página (ex.: Transmitir) apagaria uma lista guardada só na memória.
if (!window.__prumoGravando) {
  window.__prumoGravando = true;
  const xp = (el) => { let c = ""; for (; el && el.nodeType === 1; el = el.parentNode) {
      if (el.id && !/^(input|combobox|select)-\d+|\d{3,}/.test(el.id)) { return "//*[@id='" + el.id + "']" + c; }
      let i = 1; for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === el.tagName) i++;
      c = "/" + el.tagName.toLowerCase() + "[" + i + "]" + c; } return c; };
  const rot = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || el.title || "").trim().replace(/\s+/g, " ").slice(0, 80);
  const guardar = (r) => { try { const a = JSON.parse(sessionStorage.getItem("__prumoGrav") || "[]"); a.push(r); sessionStorage.setItem("__prumoGrav", JSON.stringify(a)); } catch (e) {} };
  document.addEventListener("click", (e) => { const el = e.target.closest("button, a, [role=button], [role=option], [role=tab], input[type=radio], input[type=checkbox], label") || e.target;
    guardar({ acao: "clique", xpath: xp(el), texto: rot(el), tag: el.tagName.toLowerCase() }); }, true);
  document.addEventListener("change", (e) => { const el = e.target; if (!el.matches("input, select, textarea")) return;
    guardar({ acao: el.tagName === "SELECT" ? "selecionar" : "digitar", xpath: xp(el), valor: el.tagName === "SELECT" ? el.options[el.selectedIndex]?.text : el.value }); }, true);
}
let r = []; try { r = JSON.parse(sessionStorage.getItem("__prumoGrav") || "[]"); sessionStorage.removeItem("__prumoGrav"); } catch (e) {}
return r;
"""


class PassoFalhou(Exception):
    pass


class RoboNfae:
    def __init__(self, tarefa, emitente, senha, aprender_pergunta=None):
        self.t = tarefa
        self.d = tarefa["dados"]
        self.emitente = emitente
        self.senha = senha
        self.sel = seletores()
        self.pasta = os.path.join(PASTA, "tarefas", tarefa["id"])
        os.makedirs(self.pasta, exist_ok=True)
        self.driver = None
        self.aprender_pergunta = aprender_pergunta  # função da janela para o modo aprendizado

    # ---------- utilidades Selenium ----------
    def _abrir_navegador(self):
        from selenium import webdriver
        navegador = (os.environ.get("PRUMO_NAVEGADOR") or self.sel.get("navegador") or "firefox").lower()
        if navegador == "chrome":
            from selenium.webdriver.chrome.options import Options as COptions
            from selenium.webdriver.chrome.service import Service as CService
            op = COptions()
            op.add_argument("--user-data-dir=" + os.path.join(PASTA, "chrome-perfil"))
            if os.environ.get("PRUMO_HEADLESS") == "1":
                op.add_argument("--headless=new")
            if not NO_WINDOWS and hasattr(os, "geteuid") and os.geteuid() == 0:
                op.add_argument("--no-sandbox")  # Linux como administrador (testes)
                op.add_argument("--disable-dev-shm-usage")
            if os.environ.get("PRUMO_CHROME_BIN"):
                op.binary_location = os.environ["PRUMO_CHROME_BIN"]
            op.add_experimental_option("prefs", {"download.default_directory": self.pasta, "download.prompt_for_download": False, "plugins.always_open_pdf_externally": True})
            servico = CService(os.environ["PRUMO_CHROMEDRIVER"]) if os.environ.get("PRUMO_CHROMEDRIVER") else None
            self.driver = webdriver.Chrome(options=op, service=servico) if servico else webdriver.Chrome(options=op)
            self.driver.set_window_size(1366, 900)
            return
        from selenium.webdriver.firefox.options import Options
        op = Options()
        perfil = os.path.join(PASTA, "firefox-perfil")
        os.makedirs(perfil, exist_ok=True)
        op.add_argument("-profile")
        op.add_argument(perfil)
        op.set_preference("browser.download.folderList", 2)
        op.set_preference("browser.download.dir", self.pasta)
        op.set_preference("browser.download.useDownloadDir", True)
        op.set_preference("browser.helperApps.neverAsk.saveToDisk", "application/pdf,application/xml,text/xml,application/octet-stream,application/zip")
        op.set_preference("pdfjs.disabled", True)
        self.driver = webdriver.Firefox(options=op)
        self.driver.set_window_size(1366, 900)

    def _achar(self, alvo, tempo=15, clicavel=False):
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.support.ui import WebDriverWait
        por = By.XPATH if alvo.startswith("/") or alvo.startswith("(") else By.CSS_SELECTOR
        cond = EC.element_to_be_clickable if clicavel else EC.presence_of_element_located
        try:
            return WebDriverWait(self.driver, tempo).until(cond((por, alvo)))
        except Exception:
            raise PassoFalhou(f"Não achei na tela: {alvo[:90]}")

    def _digitar(self, alvo, valor, nome):
        from selenium.webdriver.common.keys import Keys
        valor = str(valor)
        ultimo = None
        for tentativa in range(3):
            try:
                el = self._achar(alvo, clicavel=True)
                self.driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", el)
                el.click()
                el.send_keys(Keys.CONTROL, "a")
                el.send_keys(Keys.BACKSPACE)
                el.send_keys(valor)
                el.send_keys(Keys.TAB)
                time.sleep(0.4)
                if (el.get_attribute("value") or "").strip() or not valor:
                    return
                ultimo = "o campo ficou vazio"
            except Exception as e:  # noqa: BLE001
                ultimo = str(e)
            time.sleep(0.8)
        raise PassoFalhou(f"Não consegui preencher “{nome}” ({ultimo}).")

    def _selecionar(self, alvo, texto, nome):
        from selenium.webdriver.support.ui import Select
        el = self._achar(alvo)
        sel = Select(el)
        for op in sel.options:
            if op.text.strip().lower() == texto.lower() or op.text.strip().lower().startswith(texto.lower()):
                sel.select_by_visible_text(op.text)
                time.sleep(0.4)
                return
        raise PassoFalhou(f"A lista “{nome}” não tem a opção “{texto}”.")

    def _clicar(self, alvo, nome, tempo=15, obrigatorio=True):
        try:
            el = self._achar(alvo, tempo=tempo, clicavel=True)
            self.driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", el)
            try:
                el.click()
            except Exception:  # noqa: BLE001
                self.driver.execute_script("arguments[0].click();", el)
            time.sleep(0.8)
            return True
        except PassoFalhou:
            if obrigatorio:
                raise PassoFalhou(f"Não achei o botão “{nome}”.")
            return False

    @staticmethod
    def _literal(t):
        if "'" not in t:
            return f"'{t}'"
        if '"' not in t:
            return f'"{t}"'
        return "concat('" + t.replace("'", "', \"'\", '") + "')"

    def _clicar_passo(self, passo, nome):
        """Passo aprendido: tenta pelo texto do botão (resiste a mudanças de layout) e depois pelo caminho."""
        texto, tag = (passo.get("texto") or "").strip(), passo.get("tag") or "*"
        if texto and tag in ("button", "a", "label", "span", "*") and len(texto) <= 60:
            alvo = f"//{tag if tag in ('button', 'a', 'label', 'span') else '*'}[normalize-space(.)={self._literal(texto)}]"
            if self._clicar(alvo, nome, tempo=15, obrigatorio=False):
                return
        self._clicar(passo["xpath"], nome, tempo=10)

    def _clicar_texto(self, texto, tempo=10):
        xp = (f"//label[.//span[contains(@class,'slds-form-element__label') and normalize-space(text())='{texto}']] | "
              f"//label[normalize-space(text())='{texto}'] | //span[normalize-space(text())='{texto}']")
        fim = time.time() + tempo
        while time.time() < fim:
            for el in self.driver.find_elements("xpath", xp):
                if el.is_displayed():
                    self.driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", el)
                    el.click()
                    time.sleep(0.5)
                    return True
            time.sleep(0.4)
        return False

    def _print(self, nome):
        caminho = os.path.join(self.pasta, nome)
        try:
            self.driver.save_screenshot(caminho)
            return caminho
        except Exception:  # noqa: BLE001
            return None

    # ---------- roteiro ----------
    def executar(self):
        if SIMULAR:
            return self._simular()
        self._abrir_navegador()
        try:
            self._login()
            self._destinatario()
            self._operacao()
            self._produtos()
            return self._finalizar()
        except PassoFalhou as e:
            p = self._print("erro.png")
            return {"status": "erro", "mensagem": f"{e} A nota NÃO foi transmitida pelo robô — confira o portal.", "arquivos": [p] if p else []}
        finally:
            try:
                if self.driver:
                    self.driver.quit()
            except Exception:  # noqa: BLE001
                pass

    def _login(self):
        s = self.sel
        log("Entrando na Receita-PR…")
        self.driver.get(s["url_login"])
        time.sleep(2)
        campos = self.driver.find_elements("css selector", s["login_senha"])
        if campos and campos[0].is_displayed():
            self._digitar(s["login_usuario"], self.emitente["usuario"], "usuário")
            el = self._achar(s["login_senha"], clicavel=True)
            el.clear()
            el.send_keys(self.senha)
            if not self._clicar(s["login_botao"], "Entrar", tempo=5, obrigatorio=False):
                from selenium.webdriver.common.keys import Keys
                el.send_keys(Keys.ENTER)
            time.sleep(4)
            ainda = self.driver.find_elements("css selector", s["login_senha"])
            if ainda and ainda[0].is_displayed():
                raise PassoFalhou("O login não passou (senha errada, senha vencida ou o portal pediu verificação/captcha).")
        log("Abrindo a emissão de NFA-e…")
        self.driver.get(s["url_emissao"])
        time.sleep(3)
        self._clicar(s["botao_avancar"], "Avançar", tempo=8, obrigatorio=False)

    def _destinatario(self):
        c = self.d["cliente"]
        log(f"Destinatário: {c.get('nome') or c.get('razao_social')}")
        self._clicar_texto("CNPJ")
        valores = {"cnpj": re.sub(r"\D", "", c["cnpj"]), "ie": re.sub(r"\D", "", c["ie"]), "nome": c.get("razao_social") or c.get("nome"),
                   "cep": re.sub(r"\D", "", c["cep"]), "logradouro": c["logradouro"], "numero": c["numero"], "bairro": c["bairro"]}
        for campo, alvo in self.sel["destinatario"].items():
            if campo in valores and alvo:
                self._digitar(alvo, valores[campo], campo)
        self._clicar(self.sel["botao_avancar"], "Avançar", tempo=8, obrigatorio=False)

    def _operacao(self):
        from selenium.webdriver.common.keys import Keys
        op = self.sel["operacao"]
        try:
            combo = self._achar(op["natureza_combo"], tempo=10, clicavel=True)
            combo.click()
            combo.send_keys(op["natureza_valor"])
            time.sleep(0.8)
            self._clicar_texto(op["natureza_valor"], tempo=4) or combo.send_keys(Keys.ENTER)
        except PassoFalhou:
            raise PassoFalhou("Não achei o campo da natureza da operação (Venda).")
        for alvo, texto in op["selects"]:
            self._selecionar(alvo, texto, texto)
        self._clicar(self.sel["botao_avancar"], "Avançar", tempo=8, obrigatorio=False)

    def _produtos(self):
        p = self.sel["produto"]
        for n, item in enumerate(self.d["itens"], 1):
            log(f"Produto {n}/{len(self.d['itens'])}: {item['descricao'][:40]}")
            self._digitar(p["codigo"], item["codigo"], "código")
            self._digitar(p["descricao"], item["descricao"], "descrição")
            self._digitar(p["ncm"], item["ncm"], "NCM")
            self._selecionar(p["cfop"], item.get("cfop") or "5405", "CFOP")
            self._digitar(p["unidade"], item.get("unidade") or "UN", "unidade")
            self._digitar(p["qtd"], str(int(item["qtd"]) if float(item["qtd"]).is_integer() else item["qtd"]).replace(".", ","), "quantidade")
            self._digitar(p["valor"], item["valor"], "valor")
            self._clicar(p["botao_adicionar"], "Adicionar Produto")
            time.sleep(1)

    def _finalizar(self):
        passos = self.sel.get("finalizacao") or []
        if not passos:
            return self._aprender()
        log("Transmitindo (passos aprendidos)…")
        c = self.d["cliente"]
        mapa = {f"cliente.{k}": v for k, v in c.items()}
        mapa["observacao"] = self.d.get("observacao", "")
        for i, passo in enumerate(passos, 1):
            nome = passo.get("texto") or passo.get("campo") or f"passo {i}"
            if passo["acao"] == "clique":
                self._clicar_passo(passo, nome)
            elif passo["acao"] == "digitar":
                self._digitar(passo["xpath"], mapa.get(passo.get("campo"), passo.get("valor", "")), nome)
            elif passo["acao"] == "selecionar":
                self._selecionar(passo["xpath"], mapa.get(passo.get("campo"), passo.get("valor", "")), nome)
            time.sleep(1.2)
        time.sleep(5)
        return self._colher_resultado()

    def _aprender(self):
        """Primeira emissão: alguém termina a nota na tela; o robô grava os passos."""
        if not self.aprender_pergunta:
            raise PassoFalhou("O robô ainda não aprendeu a etapa de transmitir. Faça a primeira emissão com alguém no computador do robô.")
        log("Modo aprendizado: termine a nota no navegador (complete, transmita e baixe o PDF).")
        gravados = []
        terminou = threading.Event()
        threading.Thread(target=lambda: (self.aprender_pergunta(), terminou.set()), daemon=True).start()
        while not terminou.is_set():
            try:
                gravados += self.driver.execute_script(GRAVADOR_JS) or []
            except Exception:  # noqa: BLE001  (página trocando)
                pass
            time.sleep(0.5)
        try:
            gravados += self.driver.execute_script(GRAVADOR_JS) or []
        except Exception:  # noqa: BLE001
            pass
        valores = {f"cliente.{k}": str(v) for k, v in self.d["cliente"].items() if v}
        passos = []
        for g in gravados:
            if g["acao"] in ("digitar", "selecionar"):
                campo = next((k for k, v in valores.items() if v and v.strip().lower() == str(g.get("valor", "")).strip().lower()), None)
                passo = {"acao": g["acao"], "xpath": g["xpath"], **({"campo": campo} if campo else {"valor": g.get("valor", "")})}
                if passos and passos[-1]["acao"] == g["acao"] and passos[-1]["xpath"] == g["xpath"]:
                    passos[-1] = passo  # várias mudanças no mesmo campo: fica a última
                else:
                    passos.append(passo)
            elif g["acao"] == "clique" and g.get("tag") not in ("input", "select", "textarea"):
                passos.append({"acao": "clique", "xpath": g["xpath"], "texto": g.get("texto", ""), "tag": g.get("tag", "")})
        if passos:
            s = seletores()
            s["finalizacao"] = passos
            gravar_json(ARQ_SELETORES, s)
            log(f"Aprendi {len(passos)} passo(s) da finalização. Da próxima vez, faço sozinho.")
        time.sleep(3)
        return self._colher_resultado(aprendizado=True)

    def _colher_resultado(self, aprendizado=False):
        texto = ""
        try:
            texto = self.driver.find_element("tag name", "body").text
        except Exception:  # noqa: BLE001
            pass
        numero = None
        m = re.search(r"(?:NFA-?e|Nota)[^\n]{0,40}?(?:n[ºo°.]?|número)\s*[:\-]?\s*(\d{1,9})", texto, re.I) or re.search(r"\bn[ºo°]\s*(\d{3,9})\b", texto, re.I)
        if m:
            numero = m.group(1)
        time.sleep(3)  # dá tempo de terminar downloads
        arquivos = [os.path.join(self.pasta, f) for f in os.listdir(self.pasta) if os.path.splitext(f)[1].lower() in (".pdf", ".xml") and not f.endswith(".part")]
        tela = self._print("tela-final.png")
        if tela:
            arquivos.append(tela)
        erro_tela = re.search(r"(rejei|erro|inv[aá]lid|n[aã]o foi poss)", texto[:3000], re.I)
        tem_pdf = any(a.lower().endswith(".pdf") for a in arquivos)
        if (numero or tem_pdf) and not erro_tela:
            return {"status": "concluida", "mensagem": "NFA-e emitida pelo robô." + (" (primeira emissão: passos aprendidos)" if aprendizado else ""), "numero": numero, "arquivos": arquivos}
        return {"status": "conferir", "mensagem": "O robô terminou, mas não confirmou a emissão na tela" + (f" (a tela fala em “{erro_tela.group(0)}”)" if erro_tela else "") + ". Veja a imagem da tela final e confira no portal.", "numero": numero, "arquivos": arquivos}

    def _simular(self):
        log("[simulação] emitindo NFA-e de mentira…")
        time.sleep(2)
        pdf = os.path.join(self.pasta, "NFA-e-simulada.pdf")
        with open(pdf, "wb") as f:
            f.write(b"%PDF-1.4\n% NFA-e simulada pelo Agente Prumo\n")
        return {"status": "concluida", "mensagem": "Simulação: nada foi enviado à Receita.", "numero": "999" + time.strftime("%H%M%S"), "arquivos": [pdf]}


# ---------------------------------------------------------------------------
# Laço principal: pergunta, executa, devolve
# ---------------------------------------------------------------------------
class Agente:
    def __init__(self, aprender_pergunta=None, ao_mudar=None):
        self.prumo = Prumo()
        self.emitentes = []
        self.parar = threading.Event()
        self.acordar = threading.Event()
        self.pressa_ate = 0
        self.estado = "parado"
        self.ultimo_contato = None
        self.aprender_pergunta = aprender_pergunta
        self.ao_mudar = ao_mudar or (lambda: None)

    def intervalo(self):
        agora = dt.datetime.now()
        if time.time() < self.pressa_ate:
            return 5
        if agora.weekday() < 6 and 7 <= agora.hour < 19:
            return 20
        return 300

    def _mudar(self, estado):
        self.estado = estado
        self.ao_mudar()

    def rodar(self):
        falhas = 0
        quer_emitentes = True
        while not self.parar.is_set():
            if not self.prumo.vinculado:
                self._mudar("não vinculado")
                self.acordar.wait(5)
                self.acordar.clear()
                continue
            try:
                r = self.prumo.ciclo(sorted(senhas_guardadas().keys()), quer_emitentes=quer_emitentes)
                quer_emitentes = False
                falhas = 0
                self.ultimo_contato = dt.datetime.now()
                if r.get("emitentes") is not None:
                    self.emitentes = r["emitentes"]
                self._mudar("online")
                if r.get("tarefa"):
                    self.executar(r["tarefa"])
                    self.pressa_ate = time.time() + 180
                    quer_emitentes = True
                    continue
            except Desvinculado as e:
                log(f"Desvinculado pelo Prumo: {e}")
                self.prumo.desvincular_local()
                self._mudar("não vinculado")
                continue
            except Exception as e:  # noqa: BLE001
                falhas += 1
                self._mudar("sem conexão")
                log(f"Sem conexão com o Prumo ({e}). Tentando de novo…")
            espera = min(120, 10 * falhas) if falhas else self.intervalo()
            self.acordar.wait(espera)
            self.acordar.clear()

    def executar(self, tarefa):
        self._mudar("trabalhando")
        log(f"Tarefa recebida: {tarefa['tipo']} ({tarefa['id'][:8]})")
        resultado = None
        try:
            if tarefa["tipo"] != "nfae":
                resultado = {"status": "erro", "mensagem": f"Este agente não sabe fazer tarefas do tipo “{tarefa['tipo']}”. Atualize o agente."}
            else:
                emitente = next((e for e in self.emitentes if e["id"] == tarefa["dados"]["emitenteId"]), None)
                senha = senha_de(tarefa["dados"]["emitenteId"])
                if not emitente:
                    resultado = {"status": "erro", "mensagem": "Emitente não encontrado no Prumo."}
                elif not senha and not SIMULAR:
                    resultado = {"status": "erro", "mensagem": f"A senha de “{emitente['nome']}” não está cadastrada neste robô (janela do Agente → Senhas)."}
                else:
                    resultado = RoboNfae(tarefa, emitente, senha, self.aprender_pergunta).executar()
        except Exception as e:  # noqa: BLE001
            log(traceback.format_exc())
            resultado = {"status": "erro", "mensagem": f"Erro inesperado no robô: {e}. Confira no portal se a nota saiu."}
        for tentativa in range(5):  # o resultado precisa chegar: tenta algumas vezes
            try:
                self.prumo.resultado(tarefa["id"], resultado["status"], resultado.get("mensagem", ""), resultado.get("numero"), resultado.get("arquivos", []))
                log(f"Resultado enviado: {resultado['status']} — {resultado.get('mensagem', '')}")
                break
            except Exception as e:  # noqa: BLE001
                log(f"Não consegui enviar o resultado ({e}); tentando de novo em 15 s.")
                time.sleep(15)
        self._mudar("online")


# ---------------------------------------------------------------------------
# Janela (tkinter)
# ---------------------------------------------------------------------------
def janela(minimizado=False):
    import tkinter as tk
    from tkinter import messagebox, ttk

    raiz = tk.Tk()
    raiz.title(f"Agente Prumo {VERSAO}")
    raiz.geometry("660x520")
    raiz.minsize(560, 460)
    cores = {"fundo": "#16202E", "card": "#F1F3F6", "cobre": "#B4532A", "texto": "#1A2230", "suave": "#5A6577"}
    raiz.configure(bg=cores["fundo"])
    icone = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icone.ico")
    if NO_WINDOWS and os.path.exists(icone):
        try:
            raiz.iconbitmap(icone)
        except tk.TclError:
            pass
    estilo = ttk.Style()
    try:
        estilo.theme_use("clam")
    except tk.TclError:
        pass
    estilo.configure("TNotebook", background=cores["fundo"], borderwidth=0)
    estilo.configure("TNotebook.Tab", padding=(14, 6), font=("Segoe UI", 10))
    estilo.configure("TFrame", background=cores["card"])
    estilo.configure("TLabel", background=cores["card"], foreground=cores["texto"], font=("Segoe UI", 10))
    estilo.configure("Titulo.TLabel", font=("Segoe UI Semibold", 12))
    estilo.configure("Suave.TLabel", foreground=cores["suave"], font=("Segoe UI", 9))
    estilo.configure("TButton", font=("Segoe UI", 10), padding=(10, 5))

    topo = tk.Frame(raiz, bg=cores["fundo"])
    topo.pack(fill="x", padx=16, pady=(14, 8))
    tk.Label(topo, text="prumo", fg="#EFE7D8", bg=cores["fundo"], font=("Georgia", 20, "bold")).pack(side="left")
    tk.Label(topo, text="  robô do escritório", fg="#AAB4C4", bg=cores["fundo"], font=("Segoe UI", 10)).pack(side="left", pady=(8, 0))
    status_var = tk.StringVar(value="…")
    status_lbl = tk.Label(topo, textvariable=status_var, fg="#fff", bg="#5A6577", font=("Segoe UI Semibold", 10), padx=10, pady=3)
    status_lbl.pack(side="right")

    abas = ttk.Notebook(raiz)
    abas.pack(fill="both", expand=True, padx=12, pady=(0, 12))

    # ----- Pausa do modo aprendizado -----
    pedido_aprender = queue.Queue()

    def aprender_pergunta():
        feito = threading.Event()
        pedido_aprender.put(feito)
        feito.wait()

    agente = Agente(aprender_pergunta=aprender_pergunta, ao_mudar=lambda: raiz.after(0, atualizar_status))

    def mostrar_aprendizado():
        try:
            feito = pedido_aprender.get_nowait()
        except queue.Empty:
            raiz.after(400, mostrar_aprendizado)
            return
        raiz.deiconify()
        jan = tk.Toplevel(raiz)
        jan.title("Robô aprendendo")
        jan.attributes("-topmost", True)
        jan.geometry("440x260")
        jan.configure(bg=cores["card"])
        tk.Label(jan, text="Primeira emissão: termine a nota no navegador", bg=cores["card"], fg=cores["texto"], font=("Segoe UI Semibold", 11), wraplength=400).pack(pady=(16, 6))
        tk.Label(jan, text="O robô já preencheu o destinatário e os produtos. Complete o que faltar, TRANSMITA a nota e baixe o PDF.\n\nEle vai observar o que você fizer e repetir sozinho nas próximas notas. Quando a nota estiver emitida, clique em Terminei.",
                 bg=cores["card"], fg=cores["suave"], font=("Segoe UI", 10), wraplength=400, justify="left").pack(padx=16)

        def terminar():
            jan.destroy()
            feito.set()
            raiz.after(400, mostrar_aprendizado)

        tk.Button(jan, text="TERMINEI", command=terminar, bg=cores["cobre"], fg="#fff", relief="flat", font=("Segoe UI Semibold", 11), padx=18, pady=6, cursor="hand2").pack(pady=14)
        jan.protocol("WM_DELETE_WINDOW", terminar)

    raiz.after(400, mostrar_aprendizado)

    # ----- Aba Status -----
    f_status = ttk.Frame(abas, padding=14)
    abas.add(f_status, text="Status")
    info_var = tk.StringVar()
    ttk.Label(f_status, textvariable=info_var, style="Titulo.TLabel").pack(anchor="w")
    ttk.Label(f_status, text=f"Arquivos do robô: {PASTA}", style="Suave.TLabel").pack(anchor="w", pady=(2, 8))
    caixa_log = tk.Text(f_status, height=16, bg="#fff", fg=cores["texto"], relief="flat", font=("Consolas", 9), wrap="word")
    caixa_log.pack(fill="both", expand=True)
    caixa_log.configure(state="disabled")

    def puxar_log():
        try:
            while True:
                linha = _fila_log.get_nowait()
                caixa_log.configure(state="normal")
                caixa_log.insert("end", linha + "\n")
                if int(caixa_log.index("end-1c").split(".")[0]) > 400:
                    caixa_log.delete("1.0", "50.0")
                caixa_log.see("end")
                caixa_log.configure(state="disabled")
        except queue.Empty:
            pass
        raiz.after(500, puxar_log)

    raiz.after(500, puxar_log)

    def atualizar_status():
        cor = {"online": "#3E6B37", "trabalhando": "#B4532A", "sem conexão": "#B23B29", "não vinculado": "#5A6577"}.get(agente.estado, "#5A6577")
        status_var.set(agente.estado.upper())
        status_lbl.configure(bg=cor)
        p = agente.prumo.cfg
        info_var.set(f"Vinculado como “{p.get('nome')}” em {p.get('url')}" if agente.prumo.vinculado else "Este computador ainda não está vinculado ao Prumo.")
        desenhar_senhas()

    # ----- Aba Vincular -----
    f_vinc = ttk.Frame(abas, padding=16)
    abas.add(f_vinc, text="Vincular")
    ttk.Label(f_vinc, text="Vincular ao Prumo", style="Titulo.TLabel").grid(row=0, column=0, columnspan=2, sticky="w")
    ttk.Label(f_vinc, text="No Prumo: NFA-e → Robô → Vincular computador. O código vale 10 minutos.", style="Suave.TLabel").grid(row=1, column=0, columnspan=2, sticky="w", pady=(2, 12))
    url_var = tk.StringVar(value=agente.prumo.cfg.get("url", "https://"))
    cod_var = tk.StringVar()
    nome_var = tk.StringVar(value=agente.prumo.cfg.get("nome") or platform.node() or "Computador do escritório")
    for i, (rot, var) in enumerate([("Endereço do Prumo", url_var), ("Código de vínculo", cod_var), ("Nome deste computador", nome_var)]):
        ttk.Label(f_vinc, text=rot).grid(row=2 + i, column=0, sticky="w", pady=5)
        ttk.Entry(f_vinc, textvariable=var, width=44).grid(row=2 + i, column=1, sticky="we", pady=5, padx=(10, 0))
    f_vinc.columnconfigure(1, weight=1)

    def vincular():
        try:
            r = agente.prumo.vincular(url_var.get(), cod_var.get(), nome_var.get())
            log(f"Vinculado ao Prumo como “{r['nome']}”.")
            cod_var.set("")
            agente.acordar.set()
            atualizar_status()
            messagebox.showinfo("Agente Prumo", "Computador vinculado! Agora cadastre as senhas na aba Senhas.")
            abas.select(f_senhas)
        except Exception as e:  # noqa: BLE001
            messagebox.showerror("Agente Prumo", f"Não deu para vincular: {e}")

    ttk.Button(f_vinc, text="Vincular", command=vincular).grid(row=5, column=1, sticky="e", pady=(12, 0))

    # ----- Aba Senhas -----
    f_senhas = ttk.Frame(abas, padding=16)
    abas.add(f_senhas, text="Senhas")
    ttk.Label(f_senhas, text="Senhas da Receita-PR", style="Titulo.TLabel").pack(anchor="w")
    ttk.Label(f_senhas, text="Ficam protegidas pelo Windows só neste computador e nunca vão para o Prumo.", style="Suave.TLabel").pack(anchor="w", pady=(2, 10))
    lista_senhas = ttk.Frame(f_senhas)
    lista_senhas.pack(fill="both", expand=True)
    _assinatura_senhas = {"v": None}

    def desenhar_senhas():
        guardadas = senhas_guardadas()
        assinatura = json.dumps([agente.emitentes, sorted(guardadas)])
        if assinatura == _assinatura_senhas["v"]:
            return
        _assinatura_senhas["v"] = assinatura
        for w in lista_senhas.winfo_children():
            w.destroy()
        if not agente.emitentes:
            ttk.Label(lista_senhas, text="Nenhum emitente ainda. Cadastre em NFA-e → Cadastros, no Prumo.", style="Suave.TLabel").pack(anchor="w")
            return
        for e in agente.emitentes:
            linha = ttk.Frame(lista_senhas)
            linha.pack(fill="x", pady=6)
            tem = e["id"] in guardadas
            nomes = ttk.Frame(linha)
            nomes.pack(side="left", fill="x", expand=True)
            ttk.Label(nomes, text=e["nome"]).pack(anchor="w")
            ttk.Label(nomes, text=f"{e['usuario']}  ·  " + ("✓ senha guardada" if tem else "sem senha"), style="Suave.TLabel", foreground="#3E6B37" if tem else "#B23B29").pack(anchor="w")
            var = tk.StringVar()
            ent = ttk.Entry(linha, textvariable=var, show="•", width=16)
            ent.pack(side="left", padx=6)

            def salvar(eid=e["id"], v=var):
                if not v.get():
                    return
                guardar_senha(eid, v.get())
                v.set("")
                log("Senha guardada.")
                _assinatura_senhas["v"] = None
                desenhar_senhas()
                agente.acordar.set()

            def apagar(eid=e["id"]):
                guardar_senha(eid, None)
                _assinatura_senhas["v"] = None
                desenhar_senhas()
                agente.acordar.set()

            ttk.Button(linha, text="Trocar" if tem else "Salvar", command=salvar).pack(side="left")
            if tem:
                ttk.Button(linha, text="Apagar", command=apagar).pack(side="left", padx=(6, 0))

    # ----- Fechar = continuar rodando minimizado -----
    def ao_fechar():
        if messagebox.askyesno("Agente Prumo", "O robô continua trabalhando minimizado.\n\nQuer DESLIGAR o robô de vez? (Não = só minimizar)"):
            agente.parar.set()
            agente.acordar.set()
            raiz.destroy()
        else:
            raiz.iconify()

    raiz.protocol("WM_DELETE_WINDOW", ao_fechar)
    threading.Thread(target=agente.rodar, daemon=True).start()
    log(f"Agente Prumo {VERSAO} iniciado{' (SIMULAÇÃO)' if SIMULAR else ''}.")
    atualizar_status()
    if not agente.prumo.vinculado:
        abas.select(f_vinc)
    if minimizado and agente.prumo.vinculado:
        raiz.iconify()
    raiz.mainloop()


def sem_janela():
    """Modo console (testes/servidor): vínculo por linha de comando."""
    agente = Agente()
    args = sys.argv
    if "--vincular" in args:
        i = args.index("--vincular")
        url, codigo, nome = args[i + 1], args[i + 2], args[i + 3] if len(args) > i + 3 else platform.node()
        r = agente.prumo.vincular(url, codigo, nome)
        log(f"Vinculado como “{r['nome']}”.")
    if "--senha" in args:
        i = args.index("--senha")
        guardar_senha(args[i + 1], args[i + 2])
    if "--uma-vez" in args:
        r = agente.prumo.ciclo(sorted(senhas_guardadas().keys()), quer_emitentes=True)
        agente.emitentes = r.get("emitentes") or []
        if r.get("tarefa"):
            agente.executar(r["tarefa"])
        else:
            log("Nenhuma tarefa.")
        return
    agente.rodar()


if __name__ == "__main__":
    if "--sem-janela" in sys.argv:
        sem_janela()
    else:
        janela(minimizado="--minimizado" in sys.argv)
