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
import ssl
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request

VERSAO = "1.2.0"
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
_CONTEXTO_SSL = None


def contexto_ssl():
    """Certificados confiáveis = os do Windows + a lista do pacote certifi.
    No Windows Server o Windows vem com poucos certificados raiz (ele só baixa sob demanda,
    pelo Edge/Windows Update) e o Python dava "CERTIFICATE_VERIFY_FAILED" ao falar com o Prumo."""
    global _CONTEXTO_SSL
    if _CONTEXTO_SSL is None:
        ctx = ssl.create_default_context()
        try:
            import certifi  # vem junto com o Selenium
            ctx.load_verify_locations(cafile=certifi.where())
        except Exception:  # noqa: BLE001
            pass
        _CONTEXTO_SSL = ctx
    return _CONTEXTO_SSL


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
            with urllib.request.urlopen(req, timeout=timeout, context=contexto_ssl()) as r:
                return json.loads(r.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            try:
                resposta = json.loads(e.read().decode("utf-8"))
            except ValueError:
                resposta = {}
            if e.code == 401 and resposta.get("desvinculado"):
                raise Desvinculado(resposta.get("erro") or "Computador desvinculado.")
            raise RuntimeError(resposta.get("erro") or f"HTTP {e.code}")
        except urllib.error.URLError as e:
            if isinstance(getattr(e, "reason", None), ssl.SSLError) or "CERTIFICATE" in str(e).upper():
                raise RuntimeError("Erro de certificado ao falar com o Prumo. Neste computador (comum no Windows Server): "
                                   "abra o endereço do Prumo uma vez no Microsoft Edge e rode o Windows Update; depois tente de novo. "
                                   f"Detalhe: {e}")
            raise

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

    def situacao(self, tarefa_id):
        """Status atual da tarefa no Prumo (para não emitir uma nota que foi cancelada no meio)."""
        return (self._pedir("/api/robo/situacao", {"tarefaId": tarefa_id}, timeout=20) or {}).get("status")

    def resultado(self, tarefa_id, status, mensagem, numero=None, arquivos=()):
        anexos = []
        for caminho in arquivos:
            try:
                with open(caminho, "rb") as f:
                    conteudo = f.read()
                if len(conteudo) > 10_000_000:
                    continue
                nome = os.path.basename(caminho)
                tipo = {".pdf": "application/pdf", ".png": "image/png", ".xml": "application/xml", ".html": "text/html", ".txt": "text/plain"}.get(os.path.splitext(nome)[1].lower(), "application/octet-stream")
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
    # A emissão TEM que ser aberta pelo menu lateral do portal (pelo link direto a sessão não se monta)
    "menu_nfae": "//a[normalize-space()='NFA-e MEI e NFA-e (Modelo 55)']",
    "menu_emissao": "//a[normalize-space()='NFA-e MEI e NFA-e (Modelo 55)']/following-sibling::div[1]//a[normalize-space()='Emissão']",
    # Botão "Visualizar DANFE" da tela final (caminhos passados pelo escritório; o último é pelo texto, de reserva)
    "botao_danfe": [
        "//*[@id=\"app\"]/div[1]/div/div[2]/article/footer/button[3]",
        "/html/body/div/div[2]/div[2]/div[5]/div/div[1]/div/div[2]/article/footer/button[3]",
    ],
    # Consulta de NFA-e: lista do CNPJ do emitente e botão de consultar (caminhos passados pelo escritório)
    "consulta_emitente": "//*[@id=\"app\"]/div[1]/article/div[2]/div[1]/div[1]/div/select",
    "consulta_cnpj_emitente": "16821475000189",
    "consulta_botao": "//*[@id=\"app\"]/div[1]/article/footer/button[1]",
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
    # Nomes que aparecem na tela ao lado de cada campo. Se o caminho fixo acima não
    # bater (o portal mudou um pouco), o robô procura o campo pelo nome dele.
    "rotulos": {
        "cnpj": ["CNPJ", "CPF/CNPJ", "CNPJ/CPF", "CNPJ do Destinatário", "Documento"],
        "ie": ["Inscrição Estadual", "Inscrição estadual", "IE", "Insc. Estadual"],
        "nome": ["Razão Social", "Nome/Razão Social", "Nome / Razão Social", "Nome", "Razão social"],
        "cep": ["CEP"],
        "logradouro": ["Logradouro", "Endereço", "Rua"],
        "numero": ["Número", "Numero", "Nº"],
        "bairro": ["Bairro", "Bairro/Distrito"],
        "codigo": ["Código do Produto", "Código", "Cód. Produto", "Codigo"],
        "descricao": ["Descrição do Produto", "Descrição", "Descricao"],
        "ncm": ["NCM", "Código NCM"],
        "cfop": ["CFOP"],
        "unidade": ["Unidade Comercial", "Unidade", "Un. Comercial", "UN"],
        "qtd": ["Quantidade Comercial", "Quantidade", "Qtd", "Qtde"],
        "valor": ["Valor Unitário Comercial", "Valor Unitário", "Valor unitário", "Vl. Unitário", "Valor"],
    },
    # Preenchido sozinho na primeira emissão (modo aprendizado): o que você
    # fizer depois que o robô lançar os produtos (completar campos, transmitir,
    # baixar o PDF) vira passo automático para as próximas.
    "finalizacao": [],
}


def seletores():
    s = ler_json(ARQ_SELETORES, None)
    if s and s.get("finalizacao"):
        s["finalizacao"] = []  # o robô não usa mais passos aprendidos (roteiro fixo)
        gravar_json(ARQ_SELETORES, s)
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


EMITENTE_CARREGADO_JS = r"""
const v = [...document.querySelectorAll("input")].filter((e) => e.offsetParent && e.type === "text" && !e.closest("form"));
return v.length > 3 && v.filter((e) => (e.value || "").trim()).length >= 3;
"""

MARCAR_OPCAO_JS = r"""
const alvo = arguments[0].trim().toLowerCase();
for (const r of document.querySelectorAll("input[type=radio]")) {
  const lab = (r.id && document.querySelector('label[for="' + r.id + '"]')) || r.closest("label") || r.parentElement;
  const t = (lab ? lab.textContent : "").replace(/\s+/g, " ").trim().toLowerCase();
  if (t === alvo || (r.id || "").toLowerCase().startsWith(alvo + "_")) {
    if (!r.checked) { (lab && lab.tagName === "LABEL" ? lab : r).click(); }
    if (!r.checked) r.click();
    return r.checked;
  }
}
return false;
"""

NATUREZA_XPATH_ROTULO = "//label[contains(normalize-space(.), 'Natureza da Opera')]/following::input[contains(@class, 'slds-combobox__input')][1]"
NATUREZA_XPATH_FIXO = "/html/body/div[1]/div[2]/div[2]/div[5]/div/div[1]/div/div[2]/div[1]/div/div[2]/div[1]/div[1]/div/div/div/div[1]/input"
TOPO_JS = r"""
window.scrollTo(0, 0);
for (const el of document.querySelectorAll("div, main, section")) { if (el.scrollTop > 0) el.scrollTop = 0; }
"""
AVISOS_JS = r"""
const t = new Set();
for (const el of document.querySelectorAll(".slds-form-element__help, .slds-has-error .slds-form-element__help, [role=alert], .slds-notify, .toast, .alert")) {
  if (!el.offsetParent) continue;
  const x = (el.innerText || "").replace(/\s+/g, " ").trim();
  if (x && x.length < 200) t.add(x);
}
return [...t];
"""
BOTAO_DANFE_XPATH = ("//*[self::button or self::a][contains(translate(normalize-space(.), 'danfe', 'DANFE'), 'DANFE')] | "
                     "//*[self::button or self::a]//*[@title='DANFE'] | //*[self::button or self::a][@title='DANFE']")
MENU_CONSULTA_XPATH = "//a[normalize-space()='NFA-e MEI e NFA-e (Modelo 55)']/following-sibling::div[1]//a[normalize-space()='Consulta']"

# Na tabela da Consulta: primeira linha "Autorizada" com data de hoje (a lista vem da mais nova para a mais antiga)
LINHA_NOTA_HOJE_JS = r"""
const datas = [].concat(arguments[0]), doc = (arguments[1] || '').replace(/\D/g, '');
const linhas = [...document.querySelectorAll('table tbody tr')].filter((r) => r.querySelector('button'));
// se a lista mostra o CNPJ do destinatário, só aceita a linha deste cliente
const temDoc = doc && linhas.some((r) => (r.innerText || '').replace(/\D/g, '').includes(doc));
// a lista mostra CPF/CNPJ de destinatários (de outros clientes) e nenhum é deste: NÃO pega nota de outro
const docRe = /^(\d{14}|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{11}|\d{3}\.\d{3}\.\d{3}-\d{2})$/;
const mostraDoc = linhas.some((r) => [...r.children].some((td) => docRe.test((td.innerText || '').trim())));
if (doc && mostraDoc && !temDoc) return null;
for (let i = 0; i < linhas.length; i++) {
  if (temDoc && !(linhas[i].innerText || '').replace(/\D/g, '').includes(doc)) continue;
  const tds = [...linhas[i].children].map((td) => (td.innerText || '').trim());
  const sit = tds.find((t) => /autorizada/i.test(t)) || '';
  if (!/^autorizada$/i.test(sit)) continue;
  if (!tds.some((t) => datas.some((d) => t.startsWith(d)))) continue;
  const chave = (tds.find((t) => /^\d{44}$/.test(t.replace(/\s/g, ''))) || '').replace(/\s/g, '');
  const protocolo = tds.find((t) => /^\d{15}$/.test(t)) || '';
  linhas[i].setAttribute('data-prumo-linha', String(i));
  return { indice: i, chave, protocolo, doDestinatario: temDoc };
}
return null;
"""

CLICAR_ICONE_LINHA_JS = r"""
const [indice, titulo] = arguments;
const linha = document.querySelector('tr[data-prumo-linha="' + indice + '"]');
if (!linha) return false;
const i = [...linha.querySelectorAll('[title]')].find((e) => (e.getAttribute('title') || '').trim().toLowerCase() === titulo.toLowerCase());
if (!i) return false;
const b = i.closest('button,a') || i;
if (b.disabled) return false;
b.scrollIntoView({ block: 'center', inline: 'center' });
b.click();
return true;
"""

CPF_XPATH = "/html/body/div[1]/div[2]/div[2]/div[5]/div/div[1]/div/div[2]/div[1]/div[1]/div[2]/div[2]/div[1]/input"


def chrome_instalado():
    if not NO_WINDOWS:
        return False
    bases = [os.environ.get("PROGRAMFILES", r"C:\Program Files"), os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)"), os.environ.get("LOCALAPPDATA", "")]
    return any(b and os.path.exists(os.path.join(b, "Google", "Chrome", "Application", "chrome.exe")) for b in bases)


def numero_br(v):
    """'1.234,56' / '1234.56' / 12.5 -> float (ou None)."""
    if isinstance(v, (int, float)):
        return float(v)
    t = re.sub(r"[^\d,.\-]", "", str(v or ""))
    if not t:
        return None
    if "," in t:
        t = t.replace(".", "").replace(",", ".")
    try:
        return float(t)
    except ValueError:
        return None


def valor_virgula(v, casas=2):
    """Número no formato do portal (vírgula decimal, sem milhar). Mantém até 10 casas se houver."""
    n = numero_br(v)
    if n is None:
        return str(v)
    t = f"{n:.10f}".rstrip("0")
    inteiro, _, dec = t.partition(".")
    return inteiro + "," + dec.ljust(casas, "0")


class PassoFalhou(Exception):
    pass


ACHAR_POR_ROTULO_JS = r"""
const [rotulos, tipo] = arguments;
const norm = (t) => (t || "").replace(/[*:]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const alvos = rotulos.map(norm);
const visivel = (el) => !!(el && el.offsetParent !== null && el.getBoundingClientRect().width > 0);
const controleOk = (el) => el && visivel(el) && (tipo === "select" ? el.tagName === "SELECT" || el.getAttribute("role") === "combobox" :
  (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !/^(radio|checkbox|hidden|button|submit)$/i.test(el.type))));
const dentro = (raiz) => { if (!raiz) return null; for (const el of raiz.querySelectorAll("input, select, textarea, [role=combobox]")) if (controleOk(el)) return el; return null; };
for (const alvo of alvos) {
  // 1) <label> / rótulo do Salesforce com o texto exato
  for (const lab of document.querySelectorAll("label, legend, .slds-form-element__label, span, div")) {
    if (lab.children.length > 2 || norm(lab.textContent) !== alvo || !visivel(lab)) continue;
    const pelaFor = lab.htmlFor && document.getElementById(lab.htmlFor);
    if (controleOk(pelaFor)) return pelaFor;
    const bloco = lab.closest(".slds-form-element, lightning-input, lightning-combobox, lightning-select, lightning-textarea, .form-group, td, li") || lab.parentElement;
    const achado = dentro(bloco) || dentro(bloco && bloco.parentElement);
    if (achado) return achado;
  }
  // 2) placeholder / aria-label / name
  for (const el of document.querySelectorAll("input, select, textarea")) {
    if (!controleOk(el)) continue;
    const t = [el.placeholder, el.getAttribute("aria-label"), el.name, el.id].map(norm);
    if (t.some((x) => x && x === alvo)) return el;
  }
}
return null;
"""

CAMINHO_JS = r"""
let el = arguments[0], c = "";
for (; el && el.nodeType === 1 && el.tagName !== "HTML"; el = el.parentNode) {
  let i = 1; for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === el.tagName) i++;
  c = "/" + el.tagName.toLowerCase() + "[" + i + "]" + c; }
return "/html" + c;
"""

DIAGNOSTICO_JS = r"""
const vis = (el) => el.offsetParent !== null;
const linhas = ["Endereço: " + location.href, "Título: " + document.title, "Quadros (iframes): " + document.querySelectorAll("iframe").length, ""];
linhas.push("== Rótulos visíveis ==");
const vistos = new Set();
for (const l of document.querySelectorAll("label, legend, .slds-form-element__label, th")) {
  const t = (l.textContent || "").replace(/\s+/g, " ").trim(); if (!t || t.length > 60 || vistos.has(t) || !vis(l)) continue; vistos.add(t); linhas.push("- " + t);
}
linhas.push("", "== Campos visíveis ==");
const cam = (el) => { let c = ""; for (; el && el.nodeType === 1 && el.tagName !== "HTML"; el = el.parentNode) { let i = 1; for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === el.tagName) i++; c = "/" + el.tagName.toLowerCase() + "[" + i + "]" + c; } return "/html" + c; };
for (const el of document.querySelectorAll("input, select, textarea, button")) {
  if (!vis(el) || el.type === "hidden") continue;
  const rot = el.labels && el.labels[0] ? el.labels[0].textContent.replace(/\s+/g, " ").trim() : "";
  const txt = el.tagName === "BUTTON" ? (el.innerText || "").trim().slice(0, 40) : "";
  linhas.push([el.tagName.toLowerCase(), el.type || "", "rótulo=" + rot, "nome=" + (el.name || ""), "id=" + (el.id || ""), "placeholder=" + (el.placeholder || ""), txt && "texto=" + txt, cam(el)].filter(Boolean).join(" | "));
}
return linhas.join("\n");
"""


class RoboNfae:
    def __init__(self, tarefa, emitente, senha, aprender_pergunta=None, foi_cancelada=None):
        self.t = tarefa
        self.d = tarefa["dados"]
        self.emitente = emitente
        self.senha = senha
        self.sel = seletores()
        # "nfae_consulta": NÃO emite nada — só procura na Consulta a nota de uma tentativa anterior
        self.so_consulta = tarefa.get("tipo") == "nfae_consulta"
        self.pasta = os.path.join(PASTA, "tarefas", tarefa["id"], *(["consulta-" + time.strftime("%Y%m%d-%H%M%S")] if self.so_consulta else []))
        os.makedirs(self.pasta, exist_ok=True)
        self.datas_nota = self._datas_da_tentativa(tarefa.get("tentativaEm")) if self.so_consulta else [time.strftime("%d/%m/%Y")]
        self.driver = None
        self.aprender_pergunta = aprender_pergunta  # (não usado desde a 1.1.0: roteiro fixo)
        self.foi_cancelada = foi_cancelada  # pergunta ao Prumo se a nota foi cancelada

    @staticmethod
    def _datas_da_tentativa(iso):
        """Dia (no horário local) em que o robô tentou emitir, e o dia seguinte (tentativa perto da meia-noite)."""
        import datetime as _dt
        try:
            base = _dt.datetime.fromisoformat(str(iso).replace("Z", "+00:00")).astimezone()
        except Exception:  # noqa: BLE001
            base = _dt.datetime.now()
        return [(base + _dt.timedelta(days=k)).strftime("%d/%m/%Y") for k in (0, 1)]

    def _so_consultar(self):
        """Consulta de uma nota que ficou “conferir”: entra, vai na Consulta e baixa, SEM emitir."""
        log(f"Consultando no portal a nota de {self.datas_nota[0]} (sem emitir nada)…")
        self.driver.get(self.sel["url_login"])
        time.sleep(3)
        self._entrar_se_pedir()
        try:
            info = self._danfe_pela_consulta(self._arquivos_pdf()) or {}
        except PassoFalhou as e:
            p = self._print("consulta.png")
            return {"status": "conferir", "mensagem": f"Consultei o portal e não achei a nota Autorizada de {self.datas_nota[0]} para este cliente ({e}). "
                    "Se ela realmente não saiu, use “Mandar de novo”.", "arquivos": [p] if p else []}
        r = self._colher_resultado(texto_final="", extra=info)
        if r["status"] == "concluida" and not info.get("doDestinatario"):
            r["status"] = "conferir"
            r["mensagem"] = ("Achei uma nota Autorizada do dia na Consulta, mas a lista do portal não mostra o CNPJ do cliente — "
                             "confira se a DANFE anexada é desta nota antes de dar como emitida. " + r["mensagem"])
        elif r["status"] == "concluida":
            r["mensagem"] = "Achei a nota na Consulta do portal (não emiti de novo). " + r["mensagem"]
        return r

    # ---------- utilidades Selenium ----------
    def _abrir_navegador(self):
        from selenium import webdriver
        navegador = (os.environ.get("PRUMO_NAVEGADOR") or self.sel.get("navegador") or ("chrome" if chrome_instalado() else "firefox")).lower()
        if navegador == "chrome" and not os.environ.get("PRUMO_NAVEGADOR"):
            try:
                self._abrir_chrome(webdriver)
                return
            except Exception as e:  # noqa: BLE001  (sem Chrome/driver: usa o Firefox)
                log(f"Não consegui abrir o Chrome ({str(e).splitlines()[0][:100]}); usando o Firefox.")
                navegador = "firefox"
        if navegador == "chrome":
            self._abrir_chrome(webdriver)
            return
        self._abrir_firefox(webdriver)

    def _abrir_chrome(self, webdriver):
        if True:
            from selenium.webdriver.chrome.options import Options as COptions
            from selenium.webdriver.chrome.service import Service as CService
            op = COptions()
            op.add_argument("--user-data-dir=" + os.path.join(PASTA, "chrome-perfil"))
            if os.environ.get("PRUMO_HEADLESS") == "1":
                op.add_argument("--headless=new")
            if not NO_WINDOWS and hasattr(os, "geteuid") and os.geteuid() == 0:
                op.add_argument("--no-sandbox")  # Linux como administrador (testes)
                op.add_argument("--disable-dev-shm-usage")
            # continua funcionando com a janela escondida/coberta (senão o Windows "congela" a página)
            for arg in ("--disable-features=CalculateNativeWinOcclusion", "--disable-backgrounding-occluded-windows",
                        "--disable-renderer-backgrounding", "--disable-background-timer-throttling"):
                op.add_argument(arg)
            if os.environ.get("PRUMO_CHROME_BIN"):
                op.binary_location = os.environ["PRUMO_CHROME_BIN"]
            op.add_experimental_option("prefs", {"download.default_directory": self.pasta, "download.prompt_for_download": False, "plugins.always_open_pdf_externally": True,
                                                 "profile.default_content_setting_values.automatic_downloads": 1, "safebrowsing.enabled": True})
            servico = CService(os.environ["PRUMO_CHROMEDRIVER"]) if os.environ.get("PRUMO_CHROMEDRIVER") else None
            self.driver = webdriver.Chrome(options=op, service=servico) if servico else webdriver.Chrome(options=op)
            self._tamanho_janela()
            log("Navegador: Google Chrome (perfil próprio do robô).")

    def _abrir_firefox(self, webdriver):
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
        op.set_preference("layout.css.devPixelsPerPx", "1.0")  # ignora a escala de 125%/150% do Windows (a tela não corta)
        self.driver = webdriver.Firefox(options=op)
        self._tamanho_janela()
        log("Navegador: Firefox.")

    def _tamanho_janela(self):
        # do tamanho da tela (antes era fixo em 1366x900 e passava da tela com a escala do Windows)
        try:
            if os.environ.get("PRUMO_HEADLESS") == "1":
                self.driver.set_window_size(1366, 768)
            else:
                self.driver.maximize_window()
        except Exception:  # noqa: BLE001
            try:
                self.driver.set_window_size(1280, 720)
            except Exception:  # noqa: BLE001
                pass

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

    def _campo(self, grupo, chave, tempo=15, tipo="texto"):
        """Acha um campo: 1º pelo caminho guardado; se não bater, pelo nome que aparece na tela.
        Quando acha pelo nome, guarda o caminho novo em seletores.json (o robô se corrige)."""
        alvo = (self.sel.get(grupo) or {}).get(chave)
        if alvo:
            try:
                return self._achar(alvo, tempo=min(tempo, 3), clicavel=True)
            except PassoFalhou:
                pass
        rotulos = (self.sel.get("rotulos") or {}).get(chave) or SELETORES_PADRAO["rotulos"].get(chave, [])
        fim = time.time() + tempo
        while time.time() < fim:
            try:
                el = self.driver.execute_script(ACHAR_POR_ROTULO_JS, rotulos, "select" if tipo == "select" else "texto")
            except Exception:  # noqa: BLE001
                el = None
            if el is not None:
                try:
                    novo = self.driver.execute_script(CAMINHO_JS, el)
                    if novo and novo != alvo:
                        s = seletores()
                        s.setdefault(grupo, {})[chave] = novo
                        gravar_json(ARQ_SELETORES, s)
                        self.sel = s
                        log(f"Campo “{chave}” achado pelo nome na tela; caminho atualizado.")
                except Exception:  # noqa: BLE001
                    pass
                return el
            time.sleep(0.6)
        raise PassoFalhou(f"Não achei na tela o campo “{chave}” (procurei pelo caminho guardado e pelos nomes {', '.join(rotulos[:4])}).")

    def _diagnostico(self):
        """Lista o que existe na tela (rótulos, campos e botões) para ajustar o robô — sem senhas."""
        try:
            texto = self.driver.execute_script(DIAGNOSTICO_JS)
            caminho = os.path.join(self.pasta, "diagnostico.txt")
            with open(caminho, "w", encoding="utf-8") as f:
                f.write(texto)
            return caminho
        except Exception:  # noqa: BLE001
            return None

    def _preencher(self, grupo, chave, valor, nome, tempo=15, tab=False):
        """Igual ao aplicativo do escritório: clica, Ctrl+A, apaga, digita e confere.
        Só aperta TAB quando pedido (no CEP), porque o TAB faz o portal recarregar/apagar campos."""
        from selenium.webdriver.common.keys import Keys
        valor = str(valor)
        ultimo = None
        for tentativa in range(3):
            try:
                el = self._campo(grupo, chave, tempo=tempo if tentativa == 0 else 6)
                self.driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", el)
                el.click()
                time.sleep(0.2)
                el.send_keys(Keys.CONTROL, "a")
                el.send_keys(Keys.BACKSPACE)
                time.sleep(0.4)
                el.send_keys(valor)
                time.sleep(0.4)
                if tab:
                    el.send_keys(Keys.TAB)
                if (el.get_attribute("value") or "").strip() or not valor:
                    return
                ultimo = "o campo ficou vazio"
            except PassoFalhou as e:
                ultimo = str(e)
                break
            except Exception as e:  # noqa: BLE001
                ultimo = str(e).splitlines()[0][:120]
            time.sleep(0.8)
        raise PassoFalhou(f"Não consegui preencher “{nome}”. {ultimo}")

    def _escolher(self, grupo, chave, texto, nome):
        from selenium.webdriver.support.ui import Select
        el = self._campo(grupo, chave, tipo="select")
        sel = Select(el)
        for op in sel.options:
            if op.text.strip().lower() == texto.lower() or op.text.strip().lower().startswith(texto.lower()):
                sel.select_by_visible_text(op.text)
                time.sleep(0.4)
                return
        raise PassoFalhou(f"A lista “{nome}” não tem a opção “{texto}”.")

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
        # abre o navegador (se ele fechar sozinho logo na abertura, tenta mais uma vez)
        for tentativa in range(2):
            try:
                self._abrir_navegador()
                self.driver.get("about:blank")
                break
            except Exception as e:  # noqa: BLE001
                try:
                    self.driver and self.driver.quit()
                except Exception:  # noqa: BLE001
                    pass
                self.driver = None
                if tentativa:
                    return {"status": "erro", "mensagem": f"Não consegui abrir o navegador do robô ({str(e).splitlines()[0][:150]}). Nada foi enviado à Receita."}
                time.sleep(3)
        if self.so_consulta:
            try:
                return self._so_consultar()
            except Exception as e:  # noqa: BLE001
                p = self._print("erro.png")
                primeira = str(e).strip().splitlines()[0][:160] if str(e).strip() else type(e).__name__
                return {"status": "conferir", "mensagem": f"Não consegui terminar a consulta no portal ({primeira}). Nada foi emitido.", "arquivos": [p] if p else []}
            finally:
                try:
                    if self.driver:
                        self.driver.quit()
                        time.sleep(2)  # deixa o navegador fechar antes da próxima tarefa usar o mesmo perfil
                except Exception:  # noqa: BLE001
                    pass
        try:
            self._login()
            self._destinatario()
            self._operacao()
            self._produtos()
            return self._finalizar()
        except PassoFalhou as e:
            p = self._print("erro.png")
            diag = self._diagnostico()
            return {"status": "erro", "mensagem": f"{e} [robô {VERSAO}] A nota NÃO foi transmitida pelo robô — confira o portal. (Anexei a imagem da tela e um diagnóstico dos campos.)", "arquivos": [a for a in (p, diag) if a]}
        except Exception as e:  # noqa: BLE001  (navegador fechou, travou, etc.)
            p = self._print("erro.png")
            primeira = str(e).strip().splitlines()[0][:160] if str(e).strip() else type(e).__name__
            return {"status": "erro", "mensagem": f"O navegador do robô falhou no meio da emissão ({primeira}). Confira no portal se a nota saiu antes de mandar de novo.", "arquivos": [p] if p else []}
        finally:
            try:
                if self.driver:
                    self.driver.quit()
                    time.sleep(2)  # deixa o navegador terminar de fechar antes de outra emissão usar o mesmo perfil
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
        log("Abrindo a emissão de NFA-e pelo menu lateral…")
        self._abrir_pelo_menu()
        # espera o portal carregar os dados do emitente (vêm sozinhos) antes de avançar
        fim = time.time() + 25
        while time.time() < fim:
            try:
                if self.driver.execute_script(EMITENTE_CARREGADO_JS):
                    break
            except Exception:  # noqa: BLE001
                pass
            time.sleep(0.7)
        time.sleep(1)
        self._avancar_para("destinatario")

    def _abrir_pelo_menu(self):
        s = self.sel
        if "receita.pr.gov.br" not in (self.driver.current_url or "") and s["url_login"] not in (self.driver.current_url or ""):
            self.driver.get(s["url_login"])
            time.sleep(2)
        abas_antes = set(self.driver.window_handles)
        try:
            menu = self._achar(s["menu_nfae"], tempo=20)
        except PassoFalhou:
            raise PassoFalhou("Não achei no menu lateral do portal o item “NFA-e MEI e NFA-e (Modelo 55)”.")
        self.driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", menu)
        for tentativa in range(3):
            try:
                menu.click()
            except Exception:  # noqa: BLE001
                self.driver.execute_script("arguments[0].click();", menu)
            time.sleep(1.2)
            try:
                emissao = self._achar(s["menu_emissao"], tempo=4, clicavel=True)
                break
            except PassoFalhou:
                emissao = None
        if emissao is None:
            raise PassoFalhou("Abri o menu da NFA-e, mas não apareceu a opção “Emissão”.")
        try:
            emissao.click()
        except Exception:  # noqa: BLE001
            self.driver.execute_script("arguments[0].click();", emissao)
        # se o portal abrir em outra aba, passa para ela
        fim = time.time() + 25
        while time.time() < fim:
            novas = [h for h in self.driver.window_handles if h not in abas_antes]
            if novas:
                self.driver.switch_to.window(novas[-1])
            if "/nfae/avulsa/emitir" in (self.driver.current_url or ""):
                return
            time.sleep(0.5)
        raise PassoFalhou("Cliquei em “Emissão” no menu, mas a tela de emissão da NFA-e não abriu.")

    def _avancar_para(self, trecho_url, tempo=20):
        """Clica em Avançar e espera o endereço da página mudar para a próxima aba."""
        if trecho_url in (self.driver.current_url or ""):
            self._topo()
            return
        for tentativa in range(4):
            self._clicar_avancar_visivel()
            fim = time.time() + tempo / 3
            while time.time() < fim:
                if trecho_url in (self.driver.current_url or ""):
                    time.sleep(1.5)  # deixa a aba nova desenhar
                    self._topo()
                    return
                time.sleep(0.5)
        avisos = []
        try:
            avisos = self.driver.execute_script(AVISOS_JS) or []
        except Exception:  # noqa: BLE001
            pass
        detalhe = ("O portal avisou: " + "; ".join(avisos[:6]) + ".") if avisos else "Algum campo obrigatório ficou vazio ou inválido — veja a imagem da tela."
        raise PassoFalhou(f"O portal não deixou avançar para a aba “{trecho_url}”. {detalhe}")

    def _topo(self):
        """O portal deixa um quadro interno rolado para baixo ao trocar de aba (a tela fica 'em branco'): volta ao topo."""
        try:
            self.driver.execute_script(TOPO_JS)
        except Exception:  # noqa: BLE001
            pass

    def _botao_texto(self, texto, tempo=15, obrigatorio=True):
        """Clica no botão VISÍVEL com esse texto exato (ex.: 'Salvar')."""
        xp = f"//button[normalize-space(.)={self._literal(texto)}]"
        if self._clicar_avancar_visivel(tempo=tempo, xpath=xp):
            return True
        if obrigatorio:
            raise PassoFalhou(f"Não achei o botão “{texto}”.")
        return False

    def _pagamento(self):
        """Forma de Pagamento: sempre o mesmo meio (padrão 01 - Dinheiro) com o valor total da nota."""
        from selenium.webdriver.common.keys import Keys
        from selenium.webdriver.support.ui import Select
        meio = self.sel.get("pagamento_meio") or "01 - Dinheiro"
        indicador = self.sel.get("pagamento_indicador") or "0 - Pagamento"
        total = valor_virgula(self._total())
        log(f"Forma de pagamento: {meio} — R$ {total}")
        self._topo()
        self._botao_texto("Adicionar Forma de Pagamento")
        time.sleep(1.5)
        # as listas e o campo de valor ficam na janelinha "Nova Forma de Pagamento"
        fim = time.time() + 15
        selects = []
        while time.time() < fim and len(selects) < 2:
            selects = [e for e in self.driver.find_elements("css selector", "section[role=dialog] select, .slds-modal select") if e.is_displayed()]
            time.sleep(0.5)
        if not selects:
            raise PassoFalhou("A janela “Nova Forma de Pagamento” não abriu.")
        def escolhe(el, comeco, nome):
            sel = Select(el)
            for op in sel.options:
                if op.text.strip().lower().startswith(comeco.lower()):
                    sel.select_by_visible_text(op.text)
                    time.sleep(0.5)
                    return
            raise PassoFalhou(f"A lista “{nome}” não tem a opção “{comeco}”.")
        escolhe(selects[0], meio, "Meio de Pagamento")
        if len(selects) > 1:
            escolhe(selects[1], indicador, "Indicador da Forma de Pagamento")
        campos = [e for e in self.driver.find_elements("css selector", "section[role=dialog] input[type=text], .slds-modal input[type=text], section[role=dialog] input:not([type]), .slds-modal input:not([type])") if e.is_displayed()]
        if not campos:
            raise PassoFalhou("Não achei o campo “Valor do Pagamento”.")
        v = campos[0]
        v.click(); v.send_keys(Keys.CONTROL, "a"); v.send_keys(Keys.BACKSPACE); v.send_keys(total); v.send_keys(Keys.TAB)
        time.sleep(0.6)
        self._botao_texto("Salvar")
        time.sleep(1.5)

    def _abrir_novo_produto(self, n):
        """Na lista de produtos: clica em 'Adicionar Produto' e confere se o formulário abriu (repete se o clique se perdeu)."""
        time.sleep(1.5)  # a lista acabou de aparecer; dá tempo do botão ficar ativo
        for tentativa in range(4):
            self._topo()
            self._clicar_avancar_visivel(xpath=self.sel["produto"]["botao_adicionar"])
            fim = time.time() + 8
            while time.time() < fim:
                if "produto/informacao" in (self.driver.current_url or "") or "produtos/lista" not in (self.driver.current_url or ""):
                    time.sleep(1.5)
                    self._topo()
                    return
                time.sleep(0.5)
        raise PassoFalhou(f"Cliquei em “Adicionar Produto” para o produto {n}, mas o formulário não abriu.")

    def _clicar_avancar_visivel(self, tempo=10, xpath=None):
        """Clica no botão (Avançar, por padrão) que está VISÍVEL (pode haver outros escondidos na página)."""
        fim = time.time() + tempo
        while time.time() < fim:
            try:
                botoes = [b for b in self.driver.find_elements("xpath", xpath or self.sel["botao_avancar"]) if b.is_displayed() and b.is_enabled()]
            except Exception:  # noqa: BLE001
                botoes = []
            if botoes:
                b = botoes[-1]
                self.driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", b)
                time.sleep(0.4)
                try:
                    b.click()
                except Exception:  # noqa: BLE001
                    self.driver.execute_script("arguments[0].click();", b)
                time.sleep(0.8)
                return True
            time.sleep(0.5)
        return False

    def _marcar_opcao(self, texto, tempo=15):
        """Marca um botão de opção (radio) pelo texto ao lado dele, ex.: CPF / CNPJ."""
        fim = time.time() + tempo
        while time.time() < fim:
            try:
                if self.driver.execute_script(MARCAR_OPCAO_JS, texto):
                    time.sleep(0.8)
                    return True
            except Exception:  # noqa: BLE001
                pass
            time.sleep(0.5)
        return False

    def _destinatario(self):
        c = self.d["cliente"]
        log(f"Destinatário: {c.get('nome') or c.get('razao_social')}")
        doc = re.sub(r"\D", "", c.get("cnpj") or c.get("cpf") or "")
        tipo_doc = "CPF" if len(doc) == 11 else "CNPJ"
        # a tela abre com "CPF" marcado; o campo do CNPJ só aparece depois de marcar "CNPJ"
        if not self._marcar_opcao(tipo_doc):
            raise PassoFalhou(f"Não consegui marcar a opção “{tipo_doc}” do destinatário.")
        if tipo_doc == "CPF":
            self.sel.setdefault("rotulos", {})["cnpj"] = ["CPF"] + list(self.sel.get("rotulos", {}).get("cnpj", []))
            self.sel["destinatario"] = dict(self.sel["destinatario"], cnpj=self.sel["destinatario"].get("cpf", CPF_XPATH))
        valores = {"cnpj": doc, "ie": re.sub(r"\D", "", c["ie"]), "nome": c.get("razao_social") or c.get("nome"),
                   "cep": re.sub(r"\D", "", c["cep"]), "logradouro": c["logradouro"], "numero": c["numero"], "bairro": c["bairro"]}
        sem_ie = not valores["ie"]
        if sem_ie:
            log("Destinatário sem inscrição estadual (não contribuinte): deixo a IE em branco.")
            self._marcar_nao_contribuinte()
        for n, campo in enumerate([k for k in ["cnpj", "ie", "nome", "cep", "logradouro", "numero", "bairro"] if not (k == "ie" and sem_ie)]):
            self._preencher("destinatario", campo, valores[campo], {"cnpj": "CNPJ do destinatário", "ie": "Inscrição estadual", "cep": "CEP"}.get(campo, campo), tempo=25 if n == 0 else 15, tab=(campo == "cep"))
            if campo == "cep":
                time.sleep(2.5)  # o portal completa UF/Município (e às vezes a rua) pelo CEP
        # a busca do CEP às vezes apaga rua/número/bairro depois: confere e completa
        nomes = {"cnpj": "CNPJ do destinatário", "ie": "Inscrição estadual", "cep": "CEP"}
        for rodada in range(3):
            time.sleep(1.5)
            vazios = [k for k in ("ie", "nome", "logradouro", "numero", "bairro") if valores[k] and not (self._valor_campo("destinatario", k) or "").strip()]
            if not vazios:
                break
            log(f"O portal apagou {', '.join(vazios)}; preenchendo de novo.")
            for k in vazios:
                self._preencher("destinatario", k, valores[k], nomes.get(k, k))
        self._avancar_para("identificacao")

    def _marcar_nao_contribuinte(self):
        """Se a tela do destinatário tiver o indicador da IE (lista ou opção), escolhe “Não Contribuinte”."""
        from selenium.webdriver.support.ui import Select
        try:
            for el in self.driver.find_elements("css selector", "select"):
                if not el.is_displayed():
                    continue
                sel = Select(el)
                op = next((o for o in sel.options if re.search(r"n[ãa]o\s+contribuinte", o.text, re.I)), None)
                if op:
                    sel.select_by_visible_text(op.text)
                    log(f"Indicador da IE: “{op.text.strip()}”.")
                    time.sleep(0.8)
                    return True
            for texto in ("Não Contribuinte", "Não contribuinte", "Nao Contribuinte"):
                if self.driver.execute_script(MARCAR_OPCAO_JS, texto):
                    log("Indicador da IE: “Não Contribuinte”.")
                    time.sleep(0.8)
                    return True
        except Exception:  # noqa: BLE001
            pass
        log("Não vi na tela uma opção “Não Contribuinte”; sigo só com a IE em branco.")
        return False

    def _operacao(self):
        from selenium.webdriver.common.keys import Keys
        op = self.sel["operacao"]
        # o número do "combobox-id-N" muda a cada carregamento: procura pelo rótulo da tela primeiro
        alternativas = [NATUREZA_XPATH_ROTULO, NATUREZA_XPATH_FIXO, op.get("natureza_combo"), "input.slds-combobox__input"]
        combo = None
        fim = time.time() + 25
        while combo is None and time.time() < fim:
            for alvo in [a for a in alternativas if a]:
                try:
                    combo = self._achar(alvo, tempo=1)
                    break
                except Exception:  # noqa: BLE001
                    continue
        if combo is None:
            raise PassoFalhou(f"Não achei o campo da natureza da operação (Venda). [robô {VERSAO}, página {self.driver.current_url.split('/')[-1]}]")
        self.driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", combo)
        valor = op["natureza_valor"]
        for tentativa in range(3):
            try:
                combo.click()
            except Exception:  # noqa: BLE001  (algo por cima: aviso, "carregando"…)
                time.sleep(1.5)
                self.driver.execute_script("arguments[0].focus(); arguments[0].click();", combo)
            try:
                combo.send_keys(Keys.CONTROL, "a")
                combo.send_keys(Keys.BACKSPACE)
                combo.send_keys(valor)
            except Exception:  # noqa: BLE001  (campo não aceita teclado: digita pelo próprio navegador)
                self.driver.execute_script("const e=arguments[0]; e.focus(); e.value=arguments[1]; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true}));", combo, valor)
            time.sleep(1.2)
            self._clicar_texto(valor, tempo=5) or combo.send_keys(Keys.ENTER)
            time.sleep(0.6)
            if (combo.get_attribute("value") or "").strip().lower() == valor.lower():
                break
        else:
            raise PassoFalhou(f"Não consegui escolher “{valor}” na natureza da operação.")
        for alvo, texto in op["selects"]:
            self._selecionar(alvo, texto, texto)
        # depois da identificação vem "Local de Retirada/Entrega" (já vem tudo em "Não") e então Produtos
        self._avancar_para("retirada-entrega")
        self._avancar_para("produtos")

    def _produtos(self):
        p = self.sel["produto"]
        for n, item in enumerate(self.d["itens"], 1):
            log(f"Produto {n}/{len(self.d['itens'])}: {item['descricao'][:40]}")
            # o formulário do produto abre sozinho no primeiro; nos seguintes, a lista mostra "Adicionar Produto"
            fim = time.time() + 15
            while "produtos/lista" not in self.driver.current_url and "produto/" not in self.driver.current_url and time.time() < fim:
                time.sleep(0.5)
            if "produtos/lista" in self.driver.current_url:
                self._abrir_novo_produto(n)
            self._esperar_formulario_produto()
            qtd = numero_br(item["qtd"]) or 0
            textos = {"codigo": str(item["codigo"]), "descricao": item["descricao"], "ncm": re.sub(r"\D", "", str(item["ncm"])),
                      "unidade": item.get("unidade") or "UN",
                      "qtd": str(int(qtd)) if float(qtd).is_integer() else valor_virgula(qtd, 1),
                      "valor": valor_virgula(item["valor"])}
            nomes = {"codigo": "código", "descricao": "descrição", "ncm": "NCM", "unidade": "unidade", "qtd": "quantidade", "valor": "valor"}
            self._preencher("produto", "codigo", textos["codigo"], "código", tempo=25 if n == 1 else 15)
            self._preencher("produto", "descricao", textos["descricao"], "descrição")
            self._preencher("produto", "ncm", textos["ncm"], "NCM")
            self._escolher("produto", "cfop", item.get("cfop") or "5405", "CFOP")
            for chave in ("unidade", "qtd", "valor"):
                self._preencher("produto", chave, textos[chave], nomes[chave])
            # o portal às vezes apaga o que foi digitado enquanto termina de carregar: confere e completa
            for rodada in range(3):
                time.sleep(1)
                vazios = [k for k in textos if not (self._valor_campo("produto", k) or "").strip()]
                if not vazios:
                    break
                log(f"Campos apagados pelo portal ({', '.join(nomes[k] for k in vazios)}); preenchendo de novo.")
                for k in vazios:
                    self._preencher("produto", k, textos[k], nomes[k])
            # "Avançar" grava o produto e volta para a lista de produtos
            self._avancar_para("produtos/lista")

    def _esperar_formulario_produto(self, tempo=20):
        """Espera o formulário do produto terminar de carregar (lista de CFOP cheia) antes de digitar."""
        fim = time.time() + tempo
        while time.time() < fim:
            try:
                ok = self.driver.execute_script(
                    "const s=[...document.querySelectorAll('select')].filter(e=>e.offsetParent);"
                    "return s.some(e=>e.options.length>10) && !document.querySelector('.slds-spinner_container:not([hidden]) .slds-spinner, lightning-spinner');")
                if ok:
                    break
            except Exception:  # noqa: BLE001
                pass
            time.sleep(0.5)
        time.sleep(1.5)
        self._topo()

    def _valor_campo(self, grupo, chave):
        try:
            el = self._campo(grupo, chave, tempo=3)
            return el.get_attribute("value")
        except Exception:  # noqa: BLE001
            return ""

    def _total(self):
        return round(sum((numero_br(i.get("qtd")) or 0) * (numero_br(i.get("valor")) or 0) for i in self.d["itens"]), 2)

    def _finalizar(self):
        """Roteiro FIXO até o fim (sem aprender passos): pagamento → transporte → resumo → Emitir → PDF."""
        self._avancar_para("forma-pagamento")
        self._pagamento()
        self._avancar_para("transporte")
        frete = self.sel.get("frete") or "9 - Sem Ocorr"
        log(f"Transporte: {frete}")
        try:
            from selenium.webdriver.support.ui import Select
            lista = [e for e in self.driver.find_elements("css selector", "select") if e.is_displayed()]
            sel = Select(lista[0])
            op = next(o for o in sel.options if o.text.strip().lower().startswith(frete.lower()))
            sel.select_by_visible_text(op.text)
            time.sleep(0.8)
        except Exception:  # noqa: BLE001
            raise PassoFalhou(f"Não consegui escolher a modalidade do frete “{frete}”.")
        self._avancar_para("resumo")
        if os.environ.get("PRUMO_NAO_EMITIR") == "1" or self.sel.get("parar_no_resumo"):
            return {"status": "erro", "mensagem": "Parei no Resumo, sem emitir (modo conferência). Termine no portal."}
        if self.foi_cancelada:
            try:
                cancelada = self.foi_cancelada()
            except Exception:  # noqa: BLE001  (sem conexão: segue, como antes)
                cancelada = False
            if cancelada:
                log("A nota foi cancelada no Prumo: parei no Resumo, sem emitir.")
                return {"status": "cancelada", "mensagem": "Cancelada no Prumo — o robô parou antes de clicar em Emitir. Nada foi emitido."}
        log("Emitindo a NFA-e…")
        self._topo()
        self._botao_texto("Emitir")
        # alguma confirmação ("Deseja emitir?") — responde sim
        fim = time.time() + 8
        while time.time() < fim:
            try:
                self.driver.switch_to.alert.accept()
                break
            except Exception:  # noqa: BLE001
                pass
            if any(self._botao_texto(t, tempo=0.3, obrigatorio=False) for t in ("Sim", "Confirmar", "OK", "Ok")):
                break
            if "resumo" not in (self.driver.current_url or ""):
                break
            time.sleep(0.5)
        time.sleep(6)
        try:
            texto_final = self.driver.find_element("tag name", "body").text
        except Exception:  # noqa: BLE001
            texto_final = ""
        self._print("tela-final.png")
        # A tela final do portal costuma ficar em branco: o robô NÃO espera por ela.
        # Volta para receita.pr.gov.br → menu NFA-e → Consulta, acha a nota e baixa DANFE e XML.
        info = {}
        try:
            info = self._danfe_pela_consulta(self._arquivos_pdf()) or {}
        except Exception as e:  # noqa: BLE001  (a nota já foi emitida: falha aqui não pode virar "erro")
            log(f"Não consegui baixar a nota pela Consulta ({str(e).splitlines()[0][:120]}).")
        return self._colher_resultado(texto_final=texto_final, extra=info)

    def _entrar_se_pedir(self):
        """Se ao voltar para receita.pr.gov.br o portal pedir login de novo, entra outra vez."""
        s = self.sel
        campos = self.driver.find_elements("css selector", s["login_senha"])
        if not (campos and campos[0].is_displayed()):
            return
        log("O portal pediu login de novo; entrando…")
        self._digitar(s["login_usuario"], self.emitente["usuario"], "usuário")
        el = self._achar(s["login_senha"], clicavel=True)
        el.clear()
        el.send_keys(self.senha)
        if not self._clicar(s["login_botao"], "Entrar", tempo=5, obrigatorio=False):
            from selenium.webdriver.common.keys import Keys
            el.send_keys(Keys.ENTER)
        time.sleep(4)

    # ---------------- DANFE / XML ----------------
    def _arquivos_pdf(self):
        try:
            return {f for f in os.listdir(self.pasta) if f.lower().endswith(".pdf")}
        except OSError:
            return set()

    def _esperar_download(self, antes, ext=".pdf", tempo=30):
        fim = time.time() + tempo
        while time.time() < fim:
            try:
                novos = [f for f in os.listdir(self.pasta) if f.lower().endswith(ext) and f not in antes]
                pendentes = [f for f in os.listdir(self.pasta) if f.endswith((".crdownload", ".part", ".tmp"))]
            except OSError:
                novos, pendentes = [], []
            if novos and not pendentes:
                return novos
            time.sleep(0.7)
        return []

    def _baixar_danfe(self):
        antes = self._arquivos_pdf()
        # 1) tela final depois do "Emitir": botão "Visualizar DANFE" (pode demorar a aparecer — espera até 60 s)
        fim = time.time() + 60
        clicou = False
        caminhos = list(self.sel.get("botao_danfe") or SELETORES_PADRAO["botao_danfe"]) + [BOTAO_DANFE_XPATH]
        while time.time() < fim and not clicou:
            achados = []
            for xp in caminhos:
                try:
                    achados += [e for e in self.driver.find_elements("xpath", xp) if e.is_displayed()]
                except Exception:  # noqa: BLE001
                    continue
                if achados:
                    break  # usa o primeiro caminho que achar o botão
            for el in achados:
                try:
                    if not el.is_displayed():
                        continue
                    alvo = el if el.tag_name.lower() in ("button", "a") else self.driver.execute_script("return arguments[0].closest('button,a') || arguments[0];", el)
                    if alvo.get_attribute("disabled"):
                        continue
                    # trava: só clica se for mesmo o botão da DANFE (nunca um "Emitir" que esteja na mesma posição)
                    rotulo = " ".join(filter(None, [alvo.text, alvo.get_attribute("title"), alvo.get_attribute("aria-label"),
                                                    self.driver.execute_script("return [...arguments[0].querySelectorAll('[title]')].map(e => e.title).join(' ');", alvo)]))
                    if "DANFE" not in rotulo.upper():
                        continue
                    self.driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", alvo)
                    log("Clicando em “Visualizar DANFE”…")
                    abas = set(self.driver.window_handles)
                    try:
                        alvo.click()
                    except Exception:  # noqa: BLE001
                        self.driver.execute_script("arguments[0].click();", alvo)
                    clicou = True
                    if self._esperar_download(antes, tempo=40):
                        log("DANFE baixada pela tela final.")
                        self._fechar_abas_novas(abas)
                        return {}
                    self._fechar_abas_novas(abas)
                    break
                except Exception:  # noqa: BLE001
                    continue
            if not clicou:
                time.sleep(1)
        if clicou:
            log("Cliquei em “Visualizar DANFE”, mas o arquivo não baixou; vou pela Consulta.")
        # 2) Consulta de NFA-e, filtrando pelo destinatário desta nota
        return self._danfe_pela_consulta(antes)

    def _fechar_abas_novas(self, abas):
        """Se a DANFE abriu numa aba nova, guarda uma imagem dela, fecha e volta para a aba do portal."""
        try:
            for h in [h for h in self.driver.window_handles if h not in abas]:
                self.driver.switch_to.window(h)
                self.driver.save_screenshot(os.path.join(self.pasta, "danfe-tela.png"))
                self.driver.close()
            self.driver.switch_to.window(list(abas)[0] if abas else self.driver.window_handles[0])
        except Exception:  # noqa: BLE001
            pass

    def _danfe_pela_consulta(self, antes):
        from selenium.webdriver.common.keys import Keys
        from selenium.webdriver.support.ui import Select
        c = self.d["cliente"]
        doc = re.sub(r"\D", "", c.get("cnpj") or c.get("cpf") or "")
        log("Voltando para receita.pr.gov.br para consultar a nota…")
        time.sleep(4)  # dá tempo do portal registrar a nota emitida
        # fica na aba atual e fecha as outras que a emissão possa ter aberto
        try:
            atual = self.driver.current_window_handle
            for h in [h for h in self.driver.window_handles if h != atual]:
                self.driver.switch_to.window(h)
                self.driver.close()
            self.driver.switch_to.window(atual)
        except Exception:  # noqa: BLE001
            try:
                self.driver.switch_to.window(self.driver.window_handles[-1])
            except Exception:  # noqa: BLE001
                pass
        self.driver.get(self.sel["url_login"])
        time.sleep(3)
        self._entrar_se_pedir()
        log("Abrindo a Consulta de NFA-e pelo menu lateral…")
        menu = self._achar(self.sel["menu_nfae"], tempo=20)
        self.driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", menu)
        consulta = None
        for _ in range(3):
            try:
                menu.click()
            except Exception:  # noqa: BLE001
                self.driver.execute_script("arguments[0].click();", menu)
            time.sleep(1.2)
            try:
                consulta = self._achar(self.sel.get("menu_consulta") or MENU_CONSULTA_XPATH, tempo=4, clicavel=True)
                break
            except PassoFalhou:
                consulta = None
        if consulta is None:
            raise PassoFalhou("Não achei “Consulta” no menu da NFA-e.")
        consulta.click()
        fim = time.time() + 25
        while "/consulta" not in (self.driver.current_url or "") and time.time() < fim:
            time.sleep(0.5)
        time.sleep(2)
        hoje = time.strftime("%d/%m/%Y")
        cnpj_emit = re.sub(r"\D", "", self.emitente.get("cnpj") or self.sel.get("consulta_cnpj_emitente") or "")
        for tentativa in range(6):  # a nota pode levar alguns segundos para aparecer na consulta
            # 1) CNPJ do emitente na lista
            try:
                lista = self._achar(self.sel.get("consulta_emitente") or SELETORES_PADRAO["consulta_emitente"], tempo=20)
            except PassoFalhou:
                lista = next((e for e in self.driver.find_elements("css selector", "select") if e.is_displayed()), None)
            if lista is None:
                raise PassoFalhou("A tela de Consulta de NFA-e não carregou (não achei a lista do CNPJ do emitente).")
            emit = Select(lista)
            op = next((o for o in emit.options if cnpj_emit and re.sub(r"\D", "", o.text + (o.get_attribute("value") or "")).find(cnpj_emit) >= 0), None)
            if op is None:
                validas = [o for o in emit.options if not o.text.strip().lower().startswith("selecione")]
                if len(validas) == 1:
                    op = validas[0]
                else:
                    raise PassoFalhou(f"A lista de emitentes da Consulta não tem o CNPJ {cnpj_emit}.")
            emit.select_by_visible_text(op.text)
            log(f"Consulta: emitente {op.text.strip()}.")
            time.sleep(1)
            # 2) Consultar
            if not self._clicar(self.sel.get("consulta_botao") or SELETORES_PADRAO["consulta_botao"], "Consultar", tempo=10, obrigatorio=False):
                self._botao_texto("Consultar")
            time.sleep(4)
            linha = self.driver.execute_script(LINHA_NOTA_HOJE_JS, self.datas_nota, doc)
            if linha:
                break
            log("A nota ainda não apareceu na Consulta; esperando um pouco…")
            time.sleep(8)
        else:
            raise PassoFalhou(f"A nota de {self.datas_nota[0]} não apareceu na Consulta de NFA-e.")
        if not linha.get("doDestinatario"):
            log("Aviso: a lista da Consulta não mostra o CNPJ do cliente; peguei a nota Autorizada mais recente do dia.")
        chave, protocolo = linha.get("chave") or "", linha.get("protocolo") or ""
        numero = str(int(chave[25:34])) if len(chave) == 44 and chave.isdigit() else None
        # DANFE (ícone com title exatamente "DANFE" — nunca o "Cancelar" da mesma linha)
        if self.driver.execute_script(CLICAR_ICONE_LINHA_JS, linha["indice"], "DANFE"):
            if self._esperar_download(antes, tempo=40):
                log(f"DANFE baixada pela Consulta (nota nº {numero or '?'}).")
            else:
                log("Cliquei no ícone da DANFE, mas o arquivo não baixou.")
        else:
            log("Não achei o ícone da DANFE na linha da nota.")
        self._baixar_xml(linha, chave or numero or "nota")
        return {"numero": numero, "chave": chave, "protocolo": protocolo, "doDestinatario": bool(linha.get("doDestinatario"))}

    def _baixar_xml(self, linha, nome):
        """Ícone “Obter XML da nota”: aceita download direto, janela com botão de baixar ou aba com o XML."""
        antes = {f for f in os.listdir(self.pasta) if f.lower().endswith(".xml")}
        abas = set(self.driver.window_handles)
        if not self.driver.execute_script(CLICAR_ICONE_LINHA_JS, linha["indice"], "Obter XML da nota"):
            log("Não achei o ícone “Obter XML da nota” na linha da nota.")
            return
        if self._esperar_download(antes, ext=".xml", tempo=12):
            log("XML baixado.")
            return
        # abriu uma janelinha com botão (Baixar / Download / Salvar)?
        for t in ("Baixar XML", "Download XML", "Baixar", "Download", "Salvar"):
            if self._botao_texto(t, tempo=0.5, obrigatorio=False):
                if self._esperar_download(antes, ext=".xml", tempo=15):
                    log("XML baixado.")
                    self._fechar_janela_xml()
                    return
        # abriu o XML numa aba nova ou na própria tela? grava o conteúdo como arquivo
        for h in [h for h in self.driver.window_handles if h not in abas] + [self.driver.current_window_handle]:
            try:
                self.driver.switch_to.window(h)
                texto = self.driver.execute_script(
                    "const p=document.querySelector('pre,textarea'); return (p && (p.value||p.textContent)) || document.documentElement.outerHTML;")
                m = re.search(r"(<\?xml[\s\S]*?</nfeProc>|<nfeProc[\s\S]*?</nfeProc>|<NFe[\s\S]*?</NFe>)", texto or "")
                if not m:
                    texto2 = self.driver.find_element("tag name", "body").text
                    m = re.search(r"(<\?xml[\s\S]*?</nfeProc>|<nfeProc[\s\S]*?</nfeProc>|<NFe[\s\S]*?</NFe>)", texto2 or "")
                if m:
                    with open(os.path.join(self.pasta, f"NFA-e-{nome}.xml"), "w", encoding="utf-8") as f:
                        f.write(m.group(1))
                    log("XML gravado a partir da tela do portal.")
                    break
            except Exception:  # noqa: BLE001
                continue
        else:
            log("Cliquei em “Obter XML da nota”, mas o XML não veio.")
        self._fechar_abas_novas(abas)
        self._fechar_janela_xml()

    def _fechar_janela_xml(self):
        for t in ("Fechar",):  # nunca clica em nada com "Cancelar"
            if self._botao_texto(t, tempo=0.5, obrigatorio=False):
                return


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
        valores["total"] = valor_virgula(self._total())
        passos = []
        for g in gravados:
            if g["acao"] in ("digitar", "selecionar"):
                bruto = str(g.get("valor", "")).strip()
                campo = next((k for k, v in valores.items() if v and v.strip().lower() == bruto.lower()), None)
                if not campo and g["acao"] == "digitar" and numero_br(bruto) is not None and abs(numero_br(bruto) - self._total()) < 0.005:
                    campo = "total"  # o valor da nota (ex.: forma de pagamento) muda a cada emissão
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

    def _colher_resultado(self, aprendizado=False, texto_final=None, extra=None):
        texto = texto_final or ""
        if not texto:
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
        tela = os.path.join(self.pasta, "tela-final.png") if texto_final is not None and os.path.exists(os.path.join(self.pasta, "tela-final.png")) else self._print("tela-final.png")
        if tela:
            arquivos.append(tela)
        erro_tela = re.search(r"(rejei|erro|inv[aá]lid|n[aã]o foi poss)", texto[:3000], re.I)
        tem_pdf = any(a.lower().endswith(".pdf") for a in arquivos)
        extra = extra or {}
        if extra.get("numero"):
            numero = extra["numero"]
        detalhes = "".join([f" Chave {extra['chave']}." if extra.get("chave") else "", f" Protocolo {extra['protocolo']}." if extra.get("protocolo") else ""])
        if extra.get("chave"):  # achada como "Autorizada" na Consulta do portal
            return {"status": "concluida", "mensagem": "NFA-e emitida e autorizada." + detalhes + ("" if tem_pdf else " (Não consegui baixar a DANFE: baixe pela Consulta no portal.)"), "numero": numero, "arquivos": arquivos}
        if (numero or tem_pdf) and not erro_tela:
            return {"status": "concluida", "mensagem": "NFA-e emitida pelo robô." + detalhes + (" (primeira emissão: passos aprendidos)" if aprendizado else ""), "numero": numero, "arquivos": arquivos}
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
        self.emitentes_versao = None
        self.recarregar_emitentes = threading.Event()  # pedido da janela (aba Senhas)

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
                if self.recarregar_emitentes.is_set():
                    self.recarregar_emitentes.clear()
                    quer_emitentes = True
                r = self.prumo.ciclo(sorted(senhas_guardadas().keys()), quer_emitentes=quer_emitentes)
                falhas = 0
                self.ultimo_contato = dt.datetime.now()
                if r.get("emitentes") is not None:
                    if r["emitentes"] != self.emitentes and self.emitentes_versao is not None:
                        log("Lista de emitentes atualizada pelo Prumo.")
                    self.emitentes = r["emitentes"]
                    self.emitentes_versao = r.get("emitentesVersao")
                    quer_emitentes = False
                elif r.get("emitentesVersao") != self.emitentes_versao:
                    # cadastraram/alteraram emitente no Prumo: busca a lista nova já
                    quer_emitentes = True
                    self._mudar("online")
                    self.acordar.wait(1)
                    self.acordar.clear()
                    continue
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
            if tarefa["tipo"] not in ("nfae", "nfae_consulta"):
                resultado = {"status": "erro", "mensagem": f"Este agente não sabe fazer tarefas do tipo “{tarefa['tipo']}”. Atualize o agente."}
            else:
                emitente = next((e for e in self.emitentes if e["id"] == tarefa["dados"]["emitenteId"]), None)
                senha = senha_de(tarefa["dados"]["emitenteId"])
                if not emitente:
                    resultado = {"status": "erro", "mensagem": "Emitente não encontrado no Prumo."}
                elif not senha and not SIMULAR:
                    resultado = {"status": "erro", "mensagem": f"A senha de “{emitente['nome']}” não está cadastrada neste robô (janela do Agente → Senhas)."}
                else:
                    resultado = RoboNfae(tarefa, emitente, senha, self.aprender_pergunta,
                                         foi_cancelada=lambda: self.prumo.situacao(tarefa["id"]) == "cancelada").executar()
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
    ttk.Label(f_senhas, text="Ficam protegidas pelo Windows só neste computador e nunca vão para o Prumo.", style="Suave.TLabel").pack(anchor="w", pady=(2, 6))

    def buscar_emitentes():
        agente.recarregar_emitentes.set()
        agente.acordar.set()
        log("Buscando a lista de emitentes no Prumo…")

    ttk.Button(f_senhas, text="Atualizar lista do Prumo", command=buscar_emitentes).pack(anchor="e", pady=(0, 8))
    abas.bind("<<NotebookTabChanged>>", lambda e: buscar_emitentes() if abas.select() == str(f_senhas) and agente.prumo.vinculado else None)
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
