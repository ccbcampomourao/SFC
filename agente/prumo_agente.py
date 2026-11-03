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

VERSAO = "1.5.0"
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

    def ciclo(self, senhas_ids, livre=True, quer_emitentes=False, instancia=None, inicio=False, conectado=False):
        # "mudou": a lista de senhas deste computador mudou desde a última pergunta (o Prumo grava na hora)
        mudou = getattr(self, "_ultimas_senhas", None) is not None and self._ultimas_senhas != senhas_ids
        # certificados A1 (NFS-e Nacional): vai só CNPJ, nome e validade — o arquivo e a senha ficam aqui
        certs = lista_certificados()
        mudou = mudou or (getattr(self, "_ultimos_certs", None) is not None and self._ultimos_certs != certs)
        r = self._pedir("/api/robo/ciclo", {"emitentesComSenha": senhas_ids, "versao": VERSAO, "livre": livre, "querEmitentes": quer_emitentes,
                                            "instancia": instancia, "inicio": inicio, "mudou": mudou, "conectado": conectado, "certificados": certs})
        self._ultimas_senhas = list(senhas_ids)
        self._ultimos_certs = certs
        return r

    def situacao(self, tarefa_id):
        """Status atual da tarefa no Prumo (para não emitir uma nota que foi cancelada no meio)."""
        return (self._pedir("/api/robo/situacao", {"tarefaId": tarefa_id}, timeout=20) or {}).get("status")

    def resultado(self, tarefa_id, status, mensagem, numero=None, arquivos=(), resumo=None):
        anexos = []
        for caminho in arquivos:
            try:
                with open(caminho, "rb") as f:
                    conteudo = f.read()
                if len(conteudo) > 10_000_000:
                    continue
                nome = os.path.basename(caminho)
                tipo = {".pdf": "application/pdf", ".png": "image/png", ".xml": "application/xml", ".html": "text/html", ".txt": "text/plain", ".zip": "application/zip", ".json": "application/json"}.get(os.path.splitext(nome)[1].lower(), "application/octet-stream")
                anexos.append({"nome": nome, "tipo": tipo, "base64": base64.b64encode(conteudo).decode()})
            except OSError:
                pass
        corpo = {"tarefaId": tarefa_id, "status": status, "mensagem": mensagem, "numeroNota": numero, "arquivos": anexos}
        if resumo:
            corpo["resumo"] = resumo
        return self._pedir("/api/robo/resultado", corpo, timeout=180)


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
# NFS-e NACIONAL (Portal Nacional) — API oficial do Ambiente de Dados Nacional (ADN).
# Entra com o certificado A1 (.pfx) da própria empresa, que fica SÓ neste computador
# (arquivo e senha protegidos pelo Windows). O Prumo só fica sabendo do CNPJ, do nome
# e da validade. Não clica em nada e não emite nada: só baixa as notas emitidas.
# ---------------------------------------------------------------------------
ARQ_CERTIFICADOS = os.path.join(PASTA, "certificados.json")
PASTA_NFSE = os.path.join(PASTA, "nfse-nacional")  # cópia local das notas já baixadas (a próxima busca continua de onde parou)
ADN_URL = (os.environ.get("PRUMO_ADN_URL") or "https://adn.nfse.gov.br/contribuintes").rstrip("/")
ADN_CA_TESTE = os.environ.get("PRUMO_ADN_CA")  # só nos testes (portal falso)
ADN_MAX_LOTES = 400          # até 20 mil documentos por busca; se passar, a próxima busca continua
ADN_PAUSA = float(os.environ.get("PRUMO_ADN_PAUSA", "1.2"))   # segundos entre pedidos (o portal limita: HTTP 429)
ADN_ESPERAS_429 = [5, 10, 20, 30, 45, 60, 90]
EVENTOS_CANCELAMENTO = {"e101101", "e105102", "e305101"}  # cancelamento, cancelamento por substituição, cancelamento deferido


def certificados_guardados():
    return ler_json(ARQ_CERTIFICADOS, {})


def _pkcs12():
    try:
        from cryptography.hazmat.primitives.serialization import pkcs12
        return pkcs12
    except ImportError:
        raise RuntimeError("Falta o pacote cryptography. Rode: pip install -r requirements.txt")


def _cnpj_do_certificado(cert):
    """e-CNPJ ICP-Brasil: o CNPJ vem no campo 2.16.76.1.3.3 (nome alternativo) e,
    normalmente, também no nome comum ("RAZAO SOCIAL:12345678000199")."""
    from cryptography import x509
    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        for nome in san:
            if isinstance(nome, x509.OtherName) and nome.type_id.dotted_string == "2.16.76.1.3.3":
                m = re.search(rb"\d{14}", nome.value)
                if m:
                    return m.group().decode()
    except Exception:  # noqa: BLE001
        pass
    for atributo in cert.subject:
        m = re.search(r"(\d{14})\s*$", str(atributo.value))
        if m:
            return m.group(1)
    return None


def _nome_do_certificado(cert):
    from cryptography.x509.oid import NameOID
    try:
        cn = cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value
    except IndexError:
        return ""
    return re.sub(r":\d{11,14}\s*$", "", str(cn)).strip()


def _validade(cert):
    v = getattr(cert, "not_valid_after_utc", None) or cert.not_valid_after
    return v.strftime("%Y-%m-%d")


def ler_certificado(conteudo: bytes, senha: str):
    try:
        chave, cert, extras = _pkcs12().load_key_and_certificates(conteudo, (senha or "").encode("utf-8") or None)
    except ValueError:
        raise ValueError("Senha errada, ou o arquivo não é um certificado A1 (.pfx / .p12).")
    if chave is None or cert is None:
        raise ValueError("Esse arquivo não tem a chave do certificado. Precisa ser o certificado A1 (.pfx) completo.")
    cnpj = _cnpj_do_certificado(cert)
    if not cnpj:
        raise ValueError("Não achei o CNPJ dentro desse certificado. Ele precisa ser um e-CNPJ (certificado da empresa).")
    return {"cnpj": cnpj, "nome": _nome_do_certificado(cert), "validade": _validade(cert)}, chave, cert, extras or []


def guardar_certificado(conteudo: bytes, senha: str):
    info = ler_certificado(conteudo, senha)[0]
    todos = certificados_guardados()
    todos[info["cnpj"]] = {**info, "pfx": proteger(base64.b64encode(conteudo).decode()), "senha": proteger(senha or ""),
                           "guardadoEm": dt.datetime.now().isoformat(timespec="seconds")}
    gravar_json(ARQ_CERTIFICADOS, todos)
    return info


def apagar_certificado(cnpj):
    todos = certificados_guardados()
    todos.pop(cnpj, None)
    gravar_json(ARQ_CERTIFICADOS, todos)


def lista_certificados():
    """O que vai para o Prumo: só CNPJ, nome e validade (nunca o arquivo nem a senha)."""
    return [{"cnpj": c, "nome": d.get("nome", ""), "validade": d.get("validade")} for c, d in sorted(certificados_guardados().items())]


def certificado_para(cnpj):
    """Certificado da empresa ou, se não houver, um da matriz/filial (mesmo CNPJ raiz) — o portal aceita."""
    todos = certificados_guardados()
    if cnpj in todos:
        return cnpj, todos[cnpj]
    for c, d in sorted(todos.items()):
        if c[:8] == cnpj[:8]:
            return c, d
    return None, None


def contexto_com_certificado(guardado):
    """Conexão segura que se apresenta com o certificado da empresa (o portal exige).
    A chave sai protegida por uma senha aleatória num arquivo temporário que é apagado na hora."""
    import secrets
    import tempfile
    from cryptography.hazmat.primitives import serialization
    conteudo = base64.b64decode(abrir(guardado["pfx"]))
    _info, chave, cert, extras = ler_certificado(conteudo, abrir(guardado["senha"]))
    ctx = ssl.create_default_context()
    try:
        import certifi
        ctx.load_verify_locations(cafile=certifi.where())
    except Exception:  # noqa: BLE001
        pass
    if ADN_CA_TESTE:
        ctx.load_verify_locations(cafile=ADN_CA_TESTE)
    senha_tmp = secrets.token_hex(16)
    pem = chave.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.BestAvailableEncryption(senha_tmp.encode()))
    pem += cert.public_bytes(serialization.Encoding.PEM) + b"".join(x.public_bytes(serialization.Encoding.PEM) for x in extras)
    fd, caminho = tempfile.mkstemp(suffix=".pem", dir=PASTA)
    try:
        os.write(fd, pem)
        os.close(fd)
        ctx.load_cert_chain(caminho, password=senha_tmp)
    finally:
        try:
            os.remove(caminho)
        except OSError:
            pass
    return ctx


def _sem_ns(tag):
    return tag.rsplit("}", 1)[-1]


def _filho(no, *caminho):
    """Procura pelo nome do campo, sem se importar com o namespace do XML."""
    for nome in caminho:
        if no is None:
            return None
        no = next((f for f in list(no) if _sem_ns(f.tag) == nome), None)
    return no


def _texto(no, *caminho):
    n = _filho(no, *caminho)
    return (n.text or "").strip() if n is not None and n.text else ""


def _numero(s):
    try:
        return float(str(s).replace(",", ".")) if s else 0.0
    except ValueError:
        return 0.0


def ler_nfse_nacional(xml: bytes):
    """Campos que o Prumo mostra, tirados do XML da NFS-e Nacional (leiaute 1.00/1.01)."""
    import xml.etree.ElementTree as ET
    raiz = ET.fromstring(xml)
    inf = raiz if _sem_ns(raiz.tag) == "infNFSe" else next((n for n in raiz.iter() if _sem_ns(n.tag) == "infNFSe"), None)
    if inf is None:
        return None
    dps = _filho(inf, "DPS", "infDPS")
    toma = _filho(dps, "toma")
    dh = _texto(dps, "dhEmi") or _texto(inf, "dhProc")
    ret = _texto(dps, "valores", "trib", "tribMun", "tpRetISSQN")
    iss = _numero(_texto(inf, "valores", "vISSQN"))
    chave = re.sub(r"^NFS", "", inf.get("Id") or "")
    emit = _texto(inf, "emit", "CNPJ") or _texto(inf, "emit", "CPF") or _texto(dps, "prest", "CNPJ") or _texto(dps, "prest", "CPF")
    return {
        "chave": chave,
        "numero": _texto(inf, "nNFSe"),
        "dhEmi": dh,
        "data": f"{dh[8:10]}/{dh[5:7]}/{dh[0:4]}" if len(dh) >= 10 else "",
        "competencia": _texto(dps, "dCompet"),
        "emitente": emit,
        "tomadorNome": _texto(toma, "xNome"),
        "tomadorCnpj": _texto(toma, "CNPJ") or _texto(toma, "CPF"),
        "valorTotal": _numero(_texto(dps, "valores", "vServPrest", "vServ")),
        "issRetido": iss if ret in ("2", "3") else 0.0,
    }


def ler_evento_nacional(xml: bytes):
    """(chave da nota, é cancelamento?) de um evento da NFS-e Nacional."""
    import xml.etree.ElementTree as ET
    raiz = ET.fromstring(xml)
    chave, cancela = None, False
    for n in raiz.iter():
        nome = _sem_ns(n.tag)
        if nome == "chNFSe" and n.text:
            chave = n.text.strip()
        if nome in EVENTOS_CANCELAMENTO:
            cancela = True
    return chave, cancela


class PortalNacional:
    """Distribuição de documentos do ADN: GET /DFe/{NSU} devolve até 50 documentos depois do NSU informado."""

    def __init__(self, cnpj, ctx, parar=None):
        self.cnpj = cnpj
        self.ctx = ctx
        self.parar = parar

    def lote(self, nsu):
        url = f"{ADN_URL}/DFe/{int(nsu)}?cnpjConsulta={self.cnpj}&lote=true"
        falhas = 0
        for tentativa in range(len(ADN_ESPERAS_429) + 1):
            req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": f"AgentePrumo/{VERSAO}"})
            try:
                with urllib.request.urlopen(req, timeout=90, context=self.ctx) as r:
                    return json.loads(r.read().decode("utf-8") or "{}")
            except urllib.error.HTTPError as e:
                bruto = e.read()
                try:
                    corpo = json.loads(bruto.decode("utf-8"))
                except ValueError:
                    corpo = None
                if e.code == 404 and isinstance(corpo, dict):
                    return {**corpo, "LoteDFe": corpo.get("LoteDFe") or []}  # 404 = não há mais documentos
                if e.code == 429 or e.code >= 500:
                    if tentativa >= len(ADN_ESPERAS_429):
                        raise RuntimeError(f"O Portal Nacional está limitando os pedidos (HTTP {e.code}). Tente de novo mais tarde; o que já foi baixado ficou guardado.")
                    espera = ADN_ESPERAS_429[tentativa]
                    try:
                        espera = max(espera, min(120, int(e.headers.get("Retry-After") or 0)))
                    except ValueError:
                        pass
                    log(f"Portal Nacional pediu para esperar (HTTP {e.code}); tentando de novo em {espera} s…")
                    if self.parar and self.parar.wait(espera):
                        raise RuntimeError("O Agente foi desligado no meio da busca.")
                    if not self.parar:
                        time.sleep(espera)
                    continue
                if e.code in (401, 403, 495, 496):
                    raise RuntimeError("O Portal Nacional não aceitou o certificado dessa empresa. Confira se é o e-CNPJ A1 dela (ou da matriz) e se não está vencido.")
                raise RuntimeError(f"Portal Nacional respondeu HTTP {e.code}: {_erros_adn(corpo) or bruto[:200].decode('utf-8', 'replace')}")
            except urllib.error.URLError as e:
                motivo = getattr(e, "reason", e)
                if isinstance(motivo, ssl.SSLCertVerificationError) or "CERTIFICATE_VERIFY" in str(motivo).upper():
                    raise RuntimeError("Este computador não reconheceu o certificado do site do Portal Nacional. Abra https://adn.nfse.gov.br uma vez no Microsoft Edge "
                                       f"e rode o Windows Update; depois tente de novo. Detalhe: {motivo}")
                if isinstance(motivo, ssl.SSLError):
                    raise RuntimeError(f"O Portal Nacional recusou a conexão com o certificado dessa empresa ({motivo}). Confira se o certificado A1 é o dela e se não venceu.")
                falhas += 1
                if falhas >= 3:
                    raise RuntimeError(f"Sem conexão com o Portal Nacional ({motivo}).")
                time.sleep(5 * falhas)
        raise RuntimeError("Portal Nacional não respondeu.")


def _erros_adn(corpo):
    if not isinstance(corpo, dict):
        return ""
    itens = corpo.get("Erros") or []
    textos = []
    for it in itens if isinstance(itens, list) else [itens]:
        if isinstance(it, dict):
            textos.append(" — ".join(str(it.get(k)) for k in ("Codigo", "Descricao", "Complemento") if it.get(k)))
        else:
            textos.append(str(it))
    return "; ".join(t for t in textos if t)


def _gunzip_b64(texto):
    import gzip
    dados = base64.b64decode(texto)
    return gzip.decompress(dados) if dados[:2] == b"\x1f\x8b" else dados


def sincronizar_nacional(cnpj, ctx, parar=None, progresso=lambda m: None):
    """Baixa do Portal Nacional tudo o que chegou depois da última busca e guarda aqui.
    Fica só com as notas EMITIDAS por este CNPJ (as recebidas são ignoradas)."""
    pasta = os.path.join(PASTA_NFSE, cnpj)
    os.makedirs(os.path.join(pasta, "xml"), exist_ok=True)
    arq_estado = os.path.join(pasta, "estado.json")
    estado = ler_json(arq_estado, {"ultNSU": 0, "notas": {}, "canceladas": {}})
    portal = PortalNacional(cnpj, ctx, parar)
    nsu = int(estado.get("ultNSU") or 0)
    novos = 0
    for n_lote in range(ADN_MAX_LOTES):
        r = portal.lote(nsu)
        docs = r.get("LoteDFe") or []
        if not docs:
            if str(r.get("StatusProcessamento", "")).upper() == "REJEICAO":
                raise RuntimeError("Portal Nacional recusou a consulta: " + (_erros_adn(r) or "sem detalhe"))
            break
        maior = nsu
        for d in docs:
            n = int(d.get("NSU") or 0)
            maior = max(maior, n)
            try:
                xml = _gunzip_b64(d.get("ArquivoXml") or "")
            except Exception:  # noqa: BLE001
                log(f"NSU {n}: documento ilegível, pulei.")
                continue
            tipo = str(d.get("TipoDocumento") or "").upper()
            try:
                if "EVENTO" in tipo:
                    chave, cancela = ler_evento_nacional(xml)
                    if chave and cancela:
                        estado["canceladas"][chave] = n
                    continue
                nota = ler_nfse_nacional(xml)
            except Exception as e:  # noqa: BLE001
                log(f"NSU {n}: não consegui ler o XML ({e}), pulei.")
                continue
            if not nota or re.sub(r"\D", "", nota["emitente"]) != cnpj:
                continue  # nota recebida (a empresa é tomadora) ou de outro CNPJ
            chave = nota["chave"] or d.get("ChaveAcesso") or f"nsu{n}"
            nota["chave"] = chave
            with open(os.path.join(pasta, "xml", f"{chave}.xml"), "wb") as f:
                f.write(xml)
            estado["notas"][chave] = nota
            novos += 1
        if maior <= nsu:
            break  # o portal não avançou: evita ficar repetindo o mesmo lote
        nsu = maior
        estado["ultNSU"] = nsu
        gravar_json(arq_estado, estado)  # se cair no meio, a próxima busca continua daqui
        progresso(f"Portal Nacional: {len(estado['notas'])} nota(s) guardadas (NSU {nsu})")
        if parar and parar.is_set():
            raise RuntimeError("O Agente foi desligado no meio da busca; o que já veio ficou guardado.")
        time.sleep(ADN_PAUSA)
    else:
        log("Muitos documentos de uma vez: a próxima busca continua de onde esta parou.")
    gravar_json(arq_estado, estado)
    return estado, pasta, novos


def notas_do_mes(estado, mes):
    """mes = "2026-10" (mês de emissão da nota)."""
    notas = []
    for chave, nota in estado["notas"].items():
        if not str(nota.get("dhEmi", "")).startswith(mes):
            continue
        notas.append({**nota, "cancelada": chave in estado.get("canceladas", {})})
    notas.sort(key=lambda x: (int(x["numero"]) if str(x.get("numero", "")).isdigit() else 0, x.get("dhEmi", "")))
    return notas


def buscar_nfse_nacional(tarefa, parar=None):
    """Tarefa "nfse_nacional": baixa as notas emitidas no mês e devolve um ZIP + o resumo."""
    import zipfile
    d = tarefa.get("dados") or {}
    cnpj = re.sub(r"\D", "", str(d.get("cnpj") or ""))
    mes = str(d.get("mes") or "")
    if len(cnpj) != 14 or not re.fullmatch(r"\d{4}-\d{2}", mes):
        return {"status": "erro", "mensagem": "Pedido inválido (CNPJ ou mês)."}
    usado, guardado = certificado_para(cnpj)
    if not guardado:
        return {"status": "erro", "mensagem": "O certificado A1 dessa empresa não está guardado neste robô (janela do Agente → Certificados)."}
    if guardado.get("validade") and guardado["validade"] < dt.date.today().isoformat():
        return {"status": "erro", "mensagem": f"O certificado A1 dessa empresa venceu em {guardado['validade'][8:10]}/{guardado['validade'][5:7]}/{guardado['validade'][:4]}. Guarde o novo no Agente (aba Certificados)."}
    log(f"NFS-e Nacional: {d.get('empresaNome') or cnpj} — {mes[5:]}/{mes[:4]}" + (f" (certificado da matriz/filial {usado})" if usado != cnpj else ""))
    ctx = contexto_com_certificado(guardado)
    estado, pasta, novos = sincronizar_nacional(cnpj, ctx, parar, progresso=log)
    notas = notas_do_mes(estado, mes)
    saida = os.path.join(PASTA, "saida", tarefa["id"][:12])
    os.makedirs(saida, exist_ok=True)
    arquivos = []
    nome_zip = f"NFSe_Nacional_{cnpj}_{mes[5:]}-{mes[:4]}.zip"
    if notas:
        caminho_zip = os.path.join(saida, nome_zip)
        with zipfile.ZipFile(caminho_zip, "w", zipfile.ZIP_DEFLATED) as z:
            for n in notas:
                origem = os.path.join(pasta, "xml", f"{n['chave']}.xml")
                if os.path.exists(origem):
                    numero = str(n["numero"]).zfill(6) if str(n["numero"]).isdigit() else (n["numero"] or n["chave"][-8:])
                    z.write(origem, f"NFSe_{numero}{'_CANCELADA' if n['cancelada'] else ''}.xml")
        if os.path.getsize(caminho_zip) > 9_500_000:
            return {"status": "erro", "mensagem": f"O ZIP do mês ficou grande demais para mandar ao Prumo ({os.path.getsize(caminho_zip) // 1_000_000} MB). Ele está neste computador em: {caminho_zip}"}
        arquivos.append(caminho_zip)
    lista = [{"numero": int(n["numero"]) if str(n["numero"]).isdigit() else n["numero"], "existe": True,
              "dados": {k: n.get(k) for k in ("numero", "data", "competencia", "chave", "tomadorNome", "tomadorCnpj", "valorTotal", "issRetido", "cancelada")}}
             for n in notas]
    caminho_json = os.path.join(saida, "notas.json")
    with open(caminho_json, "w", encoding="utf-8") as f:
        json.dump(lista, f, ensure_ascii=False)
    arquivos.append(caminho_json)
    validas = [n for n in notas if not n["cancelada"]]
    resumo = {"emitidas": len(validas), "canceladas": len(notas) - len(validas), "valor": round(sum(n["valorTotal"] for n in validas), 2),
              "issRetido": round(sum(n["issRetido"] for n in validas), 2), "ultimoNsu": estado.get("ultNSU", 0), "zip": nome_zip if notas else None}
    reais = f"{resumo['valor']:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    texto = (f"{resumo['emitidas']} nota(s) emitida(s)" + (f" + {resumo['canceladas']} cancelada(s)" if resumo["canceladas"] else "") +
             f" em {mes[5:]}/{mes[:4]} · R$ {reais}") if notas else f"Nenhuma nota emitida em {mes[5:]}/{mes[:4]} no Portal Nacional."
    return {"status": "concluida", "mensagem": texto, "arquivos": arquivos, "resumo": resumo}


# ---------------------------------------------------------------------------
# EMISSÃO DE NFS-e NACIONAL (Sefin Nacional) — o robô monta a DPS, assina com o
# certificado A1 da empresa e transmite. Tudo fica no banco deste computador
# (prumo.db): emitentes, serviços, tomadores e as notas. O Prumo só pede e mostra,
# pelo canal direto — nada disso passa pelo KV da Cloudflare.
# Regras de preenchimento conferidas com o XSD oficial (v1.01) e com os códigos
# de erro da Sefin (E0xxx) anotados na biblioteca aberta PyNFSeNacional (MIT).
# ---------------------------------------------------------------------------
ARQ_BANCO = os.path.join(PASTA, "prumo.db")
SEFIN_URL = {"producao": "https://sefin.nfse.gov.br/SefinNacional",
             "homologacao": "https://sefin.producaorestrita.nfse.gov.br/SefinNacional"}
SEFIN_URL_TESTE = os.environ.get("PRUMO_SEFIN_URL")  # só nos testes (Sefin falsa)
# Pacote do XSD que cada ambiente aplica: 20260209 (produção) e 20261020 (NT 009, produção restrita desde 31/10/2026).
# Quando a produção virar, basta mudar aqui (ou no emitente: campo "leiaute").
LEIAUTE_DO_AMBIENTE = {"producao": "20260209", "homologacao": "20261020"}
NS_NFSE = "http://www.sped.fazenda.gov.br/nfse"
NS_DS = "http://www.w3.org/2000/09/xmldsig#"
C14N = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315"
FUSO_BRASILIA = dt.timezone(dt.timedelta(hours=-3))  # sem horário de verão desde 2019
MAX_NUMEROS_PULADOS = 20
MAX_NOTAS_POR_PEDIDO = 300
BACKUP_HORAS = float(os.environ.get("PRUMO_BACKUP_HORAS") or 4)  # (os testes encurtam)


class ErroNota(ValueError):
    """Problema no preenchimento: a nota nem é enviada (a Sefin recusaria)."""


def _digitos(s):
    return re.sub(r"\D", "", str(s or ""))


def _dv_ok(doc):
    doc = _digitos(doc)
    if len(doc) == 11:
        if doc == doc[0] * 11:
            return False
        for n in (9, 10):
            soma = sum(int(doc[i]) * (n + 1 - i) for i in range(n))
            if (soma * 10 % 11) % 10 != int(doc[n]):
                return False
        return True
    if len(doc) == 14:
        if doc == doc[0] * 14:
            return False
        for n in (12, 13):
            pesos = list(range(n - 7, 1, -1)) + list(range(9, 1, -1))
            soma = sum(int(doc[i]) * pesos[i] for i in range(n))
            dv = 11 - soma % 11
            if (0 if dv >= 10 else dv) != int(doc[n]):
                return False
        return True
    return False


def _valor(v):
    """'1.262,90' / '1262.90' / 1262.9 → '1262.90' (2 casas)."""
    from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
    t = str(v if v is not None else "").strip().replace("R$", "").strip()
    if "," in t:
        t = t.replace(".", "").replace(",", ".")
    try:
        d = Decimal(t)
    except InvalidOperation:
        raise ErroNota(f"Valor inválido: {v!r}.")
    if not d.is_finite():
        raise ErroNota(f"Valor inválido: {v!r}.")
    return str(d.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _percentual(v, nome):
    t = str(v if v is not None else "").strip().replace(",", ".")
    try:
        x = float(t)
    except ValueError:
        raise ErroNota(f"{nome}: percentual inválido ({v!r}).")
    if not 0 <= x < 100:
        raise ErroNota(f"{nome}: precisa ficar entre 0 e 99,99%.")
    return f"{x:.2f}"


def dh_emi_agora():
    """Horário de Brasília, 5 s para trás (a Sefin recusa data "no futuro" — E0008), sem voltar para o dia anterior."""
    agora = dt.datetime.now(FUSO_BRASILIA).replace(microsecond=0)
    recuado = max(agora - dt.timedelta(seconds=5), agora.replace(hour=0, minute=0, second=0))
    return recuado.isoformat()


def limpar_emitente(d):
    """Configuração de emissão da empresa (o que vem da tela do Prumo), conferida."""
    cnpj = _digitos(d.get("cnpj"))
    if len(cnpj) != 14 or not _dv_ok(cnpj):
        raise ErroNota("CNPJ do emitente inválido.")
    regime = d.get("regime")
    if regime not in ("mei", "simples"):
        raise ErroNota("Escolha o regime: MEI ou Simples Nacional (ME/EPP).")
    cmun = _digitos(d.get("cMun"))
    if len(cmun) != 7:
        raise ErroNota("Código IBGE do município do emitente precisa ter 7 números.")
    ambiente = d.get("ambiente") or "homologacao"
    if ambiente not in SEFIN_URL:
        raise ErroNota("Ambiente inválido.")
    serie = _digitos(d.get("serie")) or "1"
    if len(serie) > 5:
        raise ErroNota("Série da DPS: até 5 números.")
    leiaute = str(d.get("leiaute") or "")
    if leiaute and leiaute not in LEIAUTE_DO_AMBIENTE.values():
        raise ErroNota("Leiaute inválido.")
    return {
        "cnpj": cnpj, "nome": str(d.get("nome") or "")[:120], "im": _digitos(d.get("im"))[:15], "cMun": cmun,
        "municipio": str(d.get("municipio") or "")[:60], "regime": regime,
        "regApTribSN": int(d.get("regApTribSN") or 1) if regime == "simples" else None,
        "pTotTribSN": _percentual(d.get("pTotTribSN") or "0", "Percentual aproximado dos tributos do Simples") if regime == "simples" else None,
        "serie": serie, "ambiente": ambiente, "leiaute": leiaute,
        "infoCompl": str(d.get("infoCompl") or "").strip()[:2000],
    }


def limpar_servico(d):
    ctn = _digitos(d.get("cTribNac"))
    if len(ctn) != 6:
        raise ErroNota("Código de tributação nacional (cTribNac) precisa ter 6 números (ex.: 010701).")
    ctm = _digitos(d.get("cTribMun"))
    if ctm and len(ctm) != 3:
        raise ErroNota("Código de tributação municipal: 3 números (ou deixe em branco se a prefeitura não usa).")
    nbs = _digitos(d.get("cNBS"))
    if nbs and len(nbs) != 9:
        raise ErroNota("Código NBS: 9 números (ou deixe em branco).")
    desc = str(d.get("descricao") or "").strip()
    if not desc:
        raise ErroNota("Escreva a descrição padrão do serviço.")
    loc = _digitos(d.get("cLocPrestacao"))
    if loc and len(loc) != 7:
        raise ErroNota("Local da prestação: código IBGE com 7 números (ou deixe em branco = cidade do emitente).")
    aliq = str(d.get("pAliq") or "").strip()
    return {"id": str(d.get("id") or "")[:40] or None, "nome": str(d.get("nome") or desc)[:80], "descricao": desc[:2000],
            "cTribNac": ctn, "cTribMun": ctm, "cNBS": nbs, "cLocPrestacao": loc,
            "pAliq": _percentual(aliq, "Alíquota do ISS") if aliq else ""}


def limpar_tomador(d):
    if not d:
        return None
    doc = _digitos(d.get("doc") or d.get("cpf_cnpj"))
    if not doc:
        return None
    if not _dv_ok(doc):
        raise ErroNota(f"CPF/CNPJ do tomador inválido ({doc}).")
    nome = str(d.get("nome") or "").strip()
    if not nome:
        raise ErroNota("Tomador identificado precisa do nome (E1235).")
    t = {"doc": doc, "nome": nome[:150], "email": str(d.get("email") or "").strip()[:80], "fone": _digitos(d.get("fone"))[:20],
         "im": _digitos(d.get("im"))[:15], "end": None}
    if t["fone"] and len(t["fone"]) < 6:
        t["fone"] = ""
    e = d.get("end") or {}
    if any(str(e.get(k) or "").strip() for k in ("cep", "xLgr", "xBairro")):
        end = {"cMun": _digitos(e.get("cMun")), "cep": _digitos(e.get("cep")), "xLgr": str(e.get("xLgr") or "").strip()[:255],
               "nro": (str(e.get("nro") or "").strip() or "S/N")[:60], "xCpl": str(e.get("xCpl") or "").strip()[:156],
               "xBairro": str(e.get("xBairro") or "").strip()[:60]}
        faltam = [n for n, ok in (("CEP", len(end["cep"]) == 8), ("código IBGE da cidade", len(end["cMun"]) == 7),
                                  ("logradouro", end["xLgr"]), ("bairro", end["xBairro"])) if not ok]
        if faltam:
            raise ErroNota("Endereço do tomador incompleto: falta " + ", ".join(faltam) + ". Complete ou apague o endereço.")
        t["end"] = end
    return t


def limpar_pedido(emit, servico, p):
    """Confere uma nota antes de entrar na fila. Devolve o pedido limpo (vira a "cópia" que o Prumo reaproveita)."""
    valor = _valor(p.get("valor"))
    if float(valor) <= 0:
        raise ErroNota("O valor do serviço precisa ser maior que zero.")
    desc = str(p.get("descricao") or servico["descricao"]).strip()
    if not desc:
        raise ErroNota("Escreva a descrição do serviço.")
    comp = str(p.get("dCompet") or dt.datetime.now(FUSO_BRASILIA).date().isoformat())
    try:
        dcomp = dt.date.fromisoformat(comp)
    except ValueError:
        raise ErroNota("Data de competência inválida.")
    if dcomp > dt.datetime.now(FUSO_BRASILIA).date():
        raise ErroNota("A competência não pode ser depois de hoje.")
    tomador = limpar_tomador(p.get("tomador"))
    retido = bool(p.get("issRetido"))
    if retido:
        if emit["regime"] == "mei":
            raise ErroNota("MEI não tem ISS retido (E0583).")
        if not tomador:
            raise ErroNota("ISS retido exige o tomador identificado (E0204).")
        if not tomador["end"]:
            raise ErroNota("ISS retido exige o endereço completo do tomador (E0237).")
        if not servico.get("pAliq"):
            raise ErroNota("ISS retido de ME/EPP exige a alíquota do ISS no cadastro do serviço (E0621).")
    return {"servicoId": servico.get("id"), "servico": {k: servico[k] for k in ("nome", "cTribNac", "cTribMun", "cNBS", "cLocPrestacao", "pAliq")},
            "descricao": desc[:2000], "valor": valor, "dCompet": dcomp.isoformat(), "tomador": tomador, "issRetido": retido,
            "infoCompl": str(p.get("infoCompl") if p.get("infoCompl") is not None else emit.get("infoCompl") or "").strip()[:2000]}


def id_da_dps(emit, serie, ndps):
    return "DPS" + emit["cMun"] + "2" + emit["cnpj"].zfill(14) + str(serie).zfill(5) + str(ndps).zfill(15)


def montar_dps(emit, pedido, serie, ndps, ambiente, dh_emi=None):
    """XML da DPS (sem assinatura), na ordem exata do XSD. Devolve (elemento lxml, Id)."""
    from lxml import etree
    leiaute = emit.get("leiaute") or LEIAUTE_DO_AMBIENTE[ambiente]
    nt009 = leiaute == "20261020"
    s = pedido["servico"]

    def el(pai, tag, texto=None):
        e = etree.SubElement(pai, f"{{{NS_NFSE}}}{tag}")
        if texto is not None:
            e.text = str(texto)
        return e

    ident = id_da_dps(emit, serie, ndps)
    dps = etree.Element(f"{{{NS_NFSE}}}DPS", nsmap={None: NS_NFSE})
    dps.set("versao", "1.01")
    inf = el(dps, "infDPS")
    inf.set("Id", ident)
    el(inf, "tpAmb", "1" if ambiente == "producao" else "2")
    el(inf, "dhEmi", dh_emi or dh_emi_agora())
    el(inf, "verAplic", f"Prumo-{VERSAO}"[:20])
    el(inf, "serie", str(serie))
    el(inf, "nDPS", str(ndps))
    el(inf, "dCompet", pedido["dCompet"])
    el(inf, "tpEmit", "1")                      # o prestador é quem emite
    if nt009:
        el(inf, "finNFSe", "0")                 # NT 009: finalidade obrigatória (0 = nota normal)
    el(inf, "cLocEmi", emit["cMun"])
    prest = el(inf, "prest")                    # emitente = prestador: sem nome/endereço (E0121/E0128)
    el(prest, "CNPJ", emit["cnpj"])
    if emit.get("im"):
        el(prest, "IM", emit["im"])
    reg = el(prest, "regTrib")
    el(reg, "opSimpNac", "2" if emit["regime"] == "mei" else "3")
    if emit["regime"] == "simples":
        el(reg, "regApTribSN", str(emit.get("regApTribSN") or 1))   # só ME/EPP (E0162)
    el(reg, "regEspTrib", "0")
    t = pedido.get("tomador")
    if t:
        toma = el(inf, "toma")
        el(toma, "CNPJ" if len(t["doc"]) == 14 else "CPF", t["doc"])
        if t.get("im"):
            el(toma, "IM", t["im"])
        el(toma, "xNome", t["nome"])
        if t.get("end"):
            e = t["end"]
            end = el(toma, "end")
            nac = el(end, "endNac")
            el(nac, "cMun", e["cMun"])
            el(nac, "CEP", e["cep"])
            el(end, "xLgr", e["xLgr"])
            el(end, "nro", e["nro"])
            if e.get("xCpl"):
                el(end, "xCpl", e["xCpl"])
            el(end, "xBairro", e["xBairro"])
        if t.get("fone"):
            el(toma, "fone", t["fone"])
        if t.get("email"):
            el(toma, "email", t["email"])
    serv = el(inf, "serv")
    el(el(serv, "locPrest"), "cLocPrestacao", s.get("cLocPrestacao") or emit["cMun"])
    cserv = el(serv, "cServ")
    el(cserv, "cTribNac", s["cTribNac"])
    if s.get("cTribMun"):
        el(cserv, "cTribMun", s["cTribMun"])
    if not nt009:
        el(cserv, "xDescServ", pedido["descricao"])
    if s.get("cNBS"):
        el(cserv, "cNBS", s["cNBS"])
    if nt009:
        el(cserv, "xDescServ", pedido["descricao"])   # NT 009: a descrição foi para o fim
    if pedido.get("infoCompl"):
        el(el(serv, "infoCompl"), "xInfComp", pedido["infoCompl"])
    valores = el(inf, "valores")
    el(el(valores, "vServPrest"), "vServ", pedido["valor"])
    trib = el(valores, "trib")
    tm = el(trib, "tribMun")
    el(tm, "tribISSQN", "1")                    # operação tributável
    el(tm, "tpRetISSQN", "2" if pedido.get("issRetido") else "1")
    if pedido.get("issRetido") and s.get("pAliq"):
        el(tm, "pAliq", s["pAliq"])
    if emit["regime"] != "mei":                 # MEI não informa tributos federais (E0676)
        el(el(el(trib, "tribFed"), "piscofins"), "CST", "08")
    tt = el(trib, "totTrib")
    if emit["regime"] == "mei":
        el(tt, "indTotTrib", "0")               # MEI dispensado do valor aproximado (Decreto 8.264/2014)
    else:
        el(tt, "pTotTribSN", emit.get("pTotTribSN") or "0.00")   # ME/EPP: % aproximado do Simples (E0712)
    # Grupo IBS/CBS: o Simples Nacional está dispensado em 2026 — não vai.
    return dps, ident


def assinar_dps(dps, chave_privada, certificado):
    """Assinatura XMLDSig "enveloped" do infDPS (RSA-SHA1 + C14N 1.0, como NF-e/NFS-e). Devolve os bytes prontos para enviar."""
    import copy
    import hashlib
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    from lxml import etree

    def c14n(no):
        # Forma canônica (C14N 1.0) do trecho, padronizado SOZINHO. O libxml2 atual erra o C14N de um
        # pedaço dentro do documento (põe xmlns="" nos filhos) e a assinatura sairia inválida; isolado,
        # o resultado é o da norma (aqui não há outros namespaces herdados).
        return etree.tostring(copy.deepcopy(no), method="c14n")

    inf = dps.find(f"{{{NS_NFSE}}}infDPS")
    digest = base64.b64encode(hashlib.sha1(c14n(inf)).digest()).decode()

    def el(pai, tag, **attrs):
        e = etree.SubElement(pai, f"{{{NS_DS}}}{tag}")
        for k, v in attrs.items():
            e.set(k, v)
        return e

    assinatura = etree.SubElement(dps, f"{{{NS_DS}}}Signature", nsmap={None: NS_DS})
    si = el(assinatura, "SignedInfo")
    el(si, "CanonicalizationMethod", Algorithm=C14N)
    el(si, "SignatureMethod", Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1")
    ref = el(si, "Reference", URI="#" + inf.get("Id"))
    tr = el(ref, "Transforms")
    el(tr, "Transform", Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature")
    el(tr, "Transform", Algorithm=C14N)
    el(ref, "DigestMethod", Algorithm="http://www.w3.org/2000/09/xmldsig#sha1")
    el(ref, "DigestValue").text = digest
    assinado = chave_privada.sign(c14n(si), padding.PKCS1v15(), hashes.SHA1())
    el(assinatura, "SignatureValue").text = base64.b64encode(assinado).decode()
    der = certificado.public_bytes(serialization.Encoding.DER)
    el(el(el(assinatura, "KeyInfo"), "X509Data"), "X509Certificate").text = base64.b64encode(der).decode()
    # a Sefin exige o cabeçalho com UTF-8 (E1229)
    return etree.tostring(dps, xml_declaration=True, encoding="UTF-8")


class Sefin:
    """API de emissão da Sefin Nacional (mTLS com o A1 da empresa)."""

    def __init__(self, ambiente, ctx):
        self.base = (SEFIN_URL_TESTE or SEFIN_URL[ambiente]).rstrip("/")
        self.ctx = ctx

    def _pedir(self, metodo, caminho, corpo=None, timeout=60):
        dados = json.dumps(corpo).encode() if corpo is not None else None
        req = urllib.request.Request(self.base + caminho, data=dados, method=metodo,
                                     headers={"Accept": "application/json", "Content-Type": "application/json", "User-Agent": f"AgentePrumo/{VERSAO}"})
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=self.ctx) as r:
                bruto = r.read()
                return r.status, bruto
        except urllib.error.HTTPError as e:
            return e.code, e.read()
        except urllib.error.URLError as e:
            motivo = getattr(e, "reason", e)
            if isinstance(motivo, ssl.SSLCertVerificationError):
                raise ErroNota("Este computador não reconheceu o certificado do site da Sefin. Abra https://sefin.nfse.gov.br no Edge e rode o Windows Update.")
            if isinstance(motivo, ssl.SSLError):
                raise ErroNota(f"A Sefin recusou a conexão com o certificado A1 dessa empresa ({motivo}). Confira se é o e-CNPJ dela e se não venceu.")
            raise ConnectionError(str(motivo))

    @staticmethod
    def _json(bruto):
        try:
            return json.loads(bruto.decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            return None

    def dps_existe(self, ident):
        """Já existe nota para esta DPS? (evita emitir duas vezes quando a resposta se perdeu)"""
        status, _ = self._pedir("HEAD", f"/dps/{ident}", timeout=30)
        if status == 200:
            return True
        if status == 404:
            return False
        if status in (401, 403, 495, 496):
            raise ErroNota("A Sefin não aceitou o certificado A1 dessa empresa (vencido ou de outro CNPJ).")
        raise ConnectionError(f"a Sefin não respondeu a conferência da DPS (HTTP {status})")

    def chave_da_dps(self, ident):
        status, bruto = self._pedir("GET", f"/dps/{ident}", timeout=30)
        d = self._json(bruto) if status == 200 else None
        return (d or {}).get("chaveAcesso")

    def xml_da_nfse(self, chave):
        status, bruto = self._pedir("GET", f"/nfse/{chave}", timeout=60)
        d = self._json(bruto) if status == 200 else None
        b64 = (d or {}).get("nfseXmlGZipB64")
        return _gunzip_b64(b64) if b64 else None

    def emitir(self, xml_assinado):
        import gzip
        corpo = {"dpsXmlGZipB64": base64.b64encode(gzip.compress(xml_assinado)).decode()}
        status, bruto = self._pedir("POST", "/nfse", corpo, timeout=90)
        d = self._json(bruto)
        if d is None:
            if status == 429:
                raise ConnectionError("a Sefin pediu para esperar (muitas notas seguidas)")
            if status >= 500:
                raise ConnectionError(f"a Sefin está fora do ar (HTTP {status})")
            return {"ok": False, "erro": f"A Sefin respondeu HTTP {status} sem explicação.", "http": status}
        erros = d.get("erros") or d.get("erro") or d.get("Erros") or []
        if isinstance(erros, dict):
            erros = [erros]
        if erros:
            partes = []
            for e in erros:
                if isinstance(e, dict):
                    cod = e.get("codigo") or e.get("Codigo") or ""
                    txt = " — ".join(str(x) for x in (e.get("descricao") or e.get("Descricao") or e.get("mensagem"), e.get("complemento") or e.get("Complemento")) if x)
                    partes.append(f"[{cod}] {txt}" if cod else txt)
                else:
                    partes.append(str(e))
            return {"ok": False, "erro": " | ".join(partes)[:1500], "http": status}
        if status == 429:
            raise ConnectionError("a Sefin pediu para esperar (muitas notas seguidas)")
        if status >= 500:
            raise ConnectionError(f"a Sefin está fora do ar (HTTP {status})")
        b64 = d.get("nfseXmlGZipB64")
        if not b64:
            return {"ok": False, "erro": f"A Sefin respondeu sem a nota (HTTP {status}).", "http": status}
        xml = _gunzip_b64(b64)
        return {"ok": True, "xml": xml, "chave": d.get("chaveAcesso") or _chave_no_xml(xml),
                "alertas": [str(a.get("descricao") or a.get("Descricao") or a) if isinstance(a, dict) else str(a) for a in (d.get("alertas") or [])]}


def _chave_no_xml(xml):
    m = re.search(rb'<infNFSe[^>]*\sId="NFS([0-9A-Z]{50})"', xml or b"")
    return m.group(1).decode() if m else None


def _numero_no_xml(xml):
    m = re.search(rb"<nNFSe>(\d+)</nNFSe>", xml or b"")
    return m.group(1).decode() if m else None


def _mesma_nota(xml, pedido):
    """A nota que a Sefin já tem para este número é a mesma que estamos mandando? (valor + tomador)"""
    if not xml:
        return None
    try:
        nota = ler_nfse_nacional(xml)
    except Exception:  # noqa: BLE001
        return None
    if not nota:
        return None
    doc = (pedido.get("tomador") or {}).get("doc") or ""
    return abs(nota["valorTotal"] - float(pedido["valor"])) < 0.005 and _digitos(nota["tomadorCnpj"]) == doc


# ----- banco de dados deste computador -----
class Banco:
    """SQLite em %APPDATA%\\PrumoRobo\\prumo.db. Um arquivo só; uso por várias linhas de execução com trava."""

    def __init__(self, caminho=ARQ_BANCO):
        import sqlite3
        self.caminho = caminho
        self.trava = threading.RLock()
        self.con = sqlite3.connect(caminho, check_same_thread=False, timeout=30)
        self.con.row_factory = sqlite3.Row
        with self.trava:
            self.con.execute("PRAGMA journal_mode=WAL")
            self.con.executescript("""
            CREATE TABLE IF NOT EXISTS emitentes (cnpj TEXT PRIMARY KEY, dados TEXT NOT NULL, atualizado_em TEXT);
            CREATE TABLE IF NOT EXISTS numeracao (cnpj TEXT, ambiente TEXT, serie TEXT, proximo INTEGER, PRIMARY KEY (cnpj, ambiente, serie));
            CREATE TABLE IF NOT EXISTS servicos (id TEXT PRIMARY KEY, cnpj TEXT, dados TEXT, ativo INTEGER DEFAULT 1, atualizado_em TEXT);
            CREATE TABLE IF NOT EXISTS tomadores (cnpj TEXT, doc TEXT, nome TEXT, dados TEXT, usos INTEGER DEFAULT 0, usado_em TEXT, PRIMARY KEY (cnpj, doc));
            CREATE TABLE IF NOT EXISTS notas (
                id TEXT PRIMARY KEY, cnpj TEXT, ambiente TEXT, status TEXT, criado_em TEXT, criado_por TEXT,
                pedido TEXT, valor REAL, tomador_doc TEXT, tomador_nome TEXT, servico_nome TEXT,
                serie TEXT, ndps INTEGER, id_dps TEXT, chave TEXT, numero TEXT, emitida_em TEXT, xml BLOB,
                erro TEXT, alertas TEXT, tentativas INTEGER DEFAULT 0, atualizado_em TEXT);
            CREATE INDEX IF NOT EXISTS notas_cnpj_data ON notas (cnpj, criado_em);
            CREATE INDEX IF NOT EXISTS notas_status ON notas (status, criado_em);
            CREATE INDEX IF NOT EXISTS notas_atualizado ON notas (atualizado_em);
            CREATE TABLE IF NOT EXISTS ajustes (chave TEXT PRIMARY KEY, valor TEXT);
            """)
            # nota que estava sendo enviada quando o robô fechou: confere na Sefin antes de mandar de novo
            self.con.execute("UPDATE notas SET status='verificar' WHERE status='enviando'")
            self.con.commit()

    def q(self, sql, args=(), um=False):
        with self.trava:
            cur = self.con.execute(sql, args)
            return cur.fetchone() if um else cur.fetchall()

    def x(self, sql, args=()):
        with self.trava:
            self.con.execute(sql, args)
            self.con.commit()

    def ajuste(self, chave, valor=None):
        if valor is None:
            r = self.q("SELECT valor FROM ajustes WHERE chave=?", (chave,), um=True)
            return r["valor"] if r else None
        self.x("INSERT INTO ajustes (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor", (chave, str(valor)))


def _agora_iso():
    return dt.datetime.now(FUSO_BRASILIA).replace(microsecond=0).isoformat()


class EmissaoNacional:
    """Fila de emissão (uma nota de cada vez, na ordem) + as ações que o Prumo pode pedir."""

    def __init__(self, parar):
        self.banco = Banco()
        self.parar = parar
        self.acordar = threading.Event()
        self._contextos = {}
        self.ultimo_backup_tentado = 0

    # ---------- cadastros ----------
    def emitente(self, cnpj):
        r = self.banco.q("SELECT dados FROM emitentes WHERE cnpj=?", (cnpj,), um=True)
        return json.loads(r["dados"]) if r else None

    def servicos(self, cnpj):
        return [{**json.loads(r["dados"]), "id": r["id"]} for r in self.banco.q("SELECT id, dados FROM servicos WHERE cnpj=? AND ativo=1 ORDER BY atualizado_em DESC", (cnpj,))]

    def proximo_numero(self, cnpj, ambiente, serie):
        r = self.banco.q("SELECT proximo FROM numeracao WHERE cnpj=? AND ambiente=? AND serie=?", (cnpj, ambiente, serie), um=True)
        return r["proximo"] if r else 1

    # ---------- ações pedidas pelo Prumo (só estas existem) ----------
    def atender(self, acao, d, usuario):
        fn = getattr(self, "acao_" + acao.replace("emissao.", "").replace(".", "_"), None)
        if not acao.startswith("emissao.") or fn is None:
            raise ErroNota(f"Ação desconhecida: {acao}")
        return fn(d or {}, usuario)

    def acao_inicio(self, d, usuario):
        emitentes = {r["cnpj"]: json.loads(r["dados"]) for r in self.banco.q("SELECT cnpj, dados FROM emitentes")}
        fila = self.banco.q("SELECT COUNT(*) AS n FROM notas WHERE status IN ('fila','enviando','verificar')", um=True)["n"]
        return {"versao": VERSAO, "certificados": lista_certificados(), "emitentes": emitentes, "fila": fila}

    def acao_cadastros(self, d, usuario):
        cnpj = _digitos(d.get("cnpj"))
        emit = self.emitente(cnpj)
        tom = [{**json.loads(r["dados"]), "usos": r["usos"]} for r in self.banco.q("SELECT dados, usos FROM tomadores WHERE cnpj=? ORDER BY usos DESC, usado_em DESC LIMIT 30", (cnpj,))]
        prox = self.proximo_numero(cnpj, emit["ambiente"], emit["serie"]) if emit else 1
        _, cert = certificado_para(cnpj)
        return {"emitente": emit, "servicos": self.servicos(cnpj), "tomadores": tom, "proximoDps": prox,
                "certificado": {k: cert.get(k) for k in ("cnpj", "nome", "validade")} if cert else None}

    def acao_emitente_salvar(self, d, usuario):
        emit = limpar_emitente(d.get("emitente") or {})
        self.banco.x("INSERT INTO emitentes (cnpj, dados, atualizado_em) VALUES (?, ?, ?) ON CONFLICT(cnpj) DO UPDATE SET dados=excluded.dados, atualizado_em=excluded.atualizado_em",
                     (emit["cnpj"], json.dumps(emit, ensure_ascii=False), _agora_iso()))
        prox = d.get("proximoDps")
        if prox not in (None, ""):
            n = int(_digitos(prox) or 0)
            if n < 1:
                raise ErroNota("Próximo número da DPS precisa ser 1 ou mais.")
            self.banco.x("INSERT INTO numeracao (cnpj, ambiente, serie, proximo) VALUES (?, ?, ?, ?) ON CONFLICT(cnpj, ambiente, serie) DO UPDATE SET proximo=excluded.proximo",
                         (emit["cnpj"], emit["ambiente"], emit["serie"], n))
        log(f"Emissão: configuração de {emit['nome'] or emit['cnpj']} salva por {usuario} ({'PRODUÇÃO' if emit['ambiente'] == 'producao' else 'produção restrita'}).")
        return self.acao_cadastros({"cnpj": emit["cnpj"]}, usuario)

    def acao_servico_salvar(self, d, usuario):
        import uuid
        cnpj = _digitos(d.get("cnpj"))
        if not self.emitente(cnpj):
            raise ErroNota("Configure a empresa antes de cadastrar serviços.")
        s = limpar_servico(d.get("servico") or {})
        sid = s.pop("id") or uuid.uuid4().hex[:12]
        self.banco.x("INSERT INTO servicos (id, cnpj, dados, ativo, atualizado_em) VALUES (?, ?, ?, 1, ?) ON CONFLICT(id) DO UPDATE SET dados=excluded.dados, ativo=1, atualizado_em=excluded.atualizado_em",
                     (sid, cnpj, json.dumps(s, ensure_ascii=False), _agora_iso()))
        return {"servicos": self.servicos(cnpj), "id": sid}

    def acao_servico_apagar(self, d, usuario):
        cnpj = _digitos(d.get("cnpj"))
        self.banco.x("UPDATE servicos SET ativo=0 WHERE id=? AND cnpj=?", (str(d.get("id")), cnpj))
        return {"servicos": self.servicos(cnpj)}

    def acao_tomador_buscar(self, d, usuario):
        cnpj = _digitos(d.get("cnpj"))
        texto = str(d.get("texto") or "").strip()
        digitos = _digitos(texto)
        if digitos and len(digitos) >= 3 and digitos == texto.replace(".", "").replace("-", "").replace("/", ""):
            linhas = self.banco.q("SELECT dados, usos FROM tomadores WHERE cnpj=? AND doc LIKE ? ORDER BY usos DESC LIMIT 20", (cnpj, digitos + "%"))
        else:
            linhas = self.banco.q("SELECT dados, usos FROM tomadores WHERE cnpj=? AND nome LIKE ? ORDER BY usos DESC LIMIT 20", (cnpj, "%" + texto + "%"))
        return {"tomadores": [{**json.loads(r["dados"]), "usos": r["usos"]} for r in linhas]}

    def acao_tomador_apagar(self, d, usuario):
        self.banco.x("DELETE FROM tomadores WHERE cnpj=? AND doc=?", (_digitos(d.get("cnpj")), _digitos(d.get("doc"))))
        return {"ok": True}

    def acao_emitir(self, d, usuario):
        """Põe notas na fila. Confere tudo antes: nota com problema volta com o motivo e não entra."""
        import uuid
        cnpj = _digitos(d.get("cnpj"))
        emit = self.emitente(cnpj)
        if not emit:
            raise ErroNota("Essa empresa ainda não está configurada para emitir (aba Configuração).")
        _, cert = certificado_para(cnpj)
        if not cert:
            raise ErroNota("O certificado A1 dessa empresa não está no robô (janela do Agente → Certificados).")
        if cert.get("validade") and cert["validade"] < dt.date.today().isoformat():
            raise ErroNota("O certificado A1 dessa empresa está vencido.")
        servicos = {s["id"]: s for s in self.servicos(cnpj)}
        notas = (d.get("notas") or [])[:MAX_NOTAS_POR_PEDIDO]
        resultado = []
        for i, p in enumerate(notas):
            try:
                serv = servicos.get(str(p.get("servicoId") or ""))
                if not serv:
                    raise ErroNota("Escolha um serviço cadastrado.")
                pedido = limpar_pedido(emit, serv, p)
                nid = uuid.uuid4().hex
                t = pedido["tomador"] or {}
                agora = _agora_iso()
                self.banco.x("""INSERT INTO notas (id, cnpj, ambiente, status, criado_em, criado_por, pedido, valor, tomador_doc, tomador_nome, servico_nome, atualizado_em)
                                VALUES (?, ?, ?, 'fila', ?, ?, ?, ?, ?, ?, ?, ?)""",
                             (nid, cnpj, emit["ambiente"], agora, str(usuario)[:60], json.dumps(pedido, ensure_ascii=False), float(pedido["valor"]),
                              t.get("doc"), t.get("nome"), serv["nome"], agora))
                if t:
                    self.banco.x("""INSERT INTO tomadores (cnpj, doc, nome, dados, usos, usado_em) VALUES (?, ?, ?, ?, 1, ?)
                                    ON CONFLICT(cnpj, doc) DO UPDATE SET nome=excluded.nome, dados=excluded.dados, usos=usos+1, usado_em=excluded.usado_em""",
                                 (cnpj, t["doc"], t["nome"], json.dumps(t, ensure_ascii=False), agora))
                resultado.append({"i": i, "id": nid})
            except ErroNota as e:
                resultado.append({"i": i, "erro": str(e)})
        if any("id" in r for r in resultado):
            self.acordar.set()
        return {"resultado": resultado}

    def _resumo(self, r):
        return {"id": r["id"], "status": r["status"], "criadoEm": r["criado_em"], "criadoPor": r["criado_por"], "emitidaEm": r["emitida_em"],
                "numero": r["numero"], "chave": r["chave"], "valor": r["valor"], "tomadorDoc": r["tomador_doc"], "tomadorNome": r["tomador_nome"],
                "servico": r["servico_nome"], "erro": r["erro"], "ambiente": r["ambiente"], "nDps": r["ndps"], "serie": r["serie"],
                "alertas": json.loads(r["alertas"]) if r["alertas"] else []}

    def acao_notas(self, d, usuario):
        cnpj = _digitos(d.get("cnpj"))
        cond, args = ["cnpj=?"], [cnpj]
        if d.get("de"):
            cond.append("criado_em >= ?"); args.append(str(d["de"])[:10])
        if d.get("ate"):
            cond.append("criado_em < ?"); args.append((dt.date.fromisoformat(str(d["ate"])[:10]) + dt.timedelta(days=1)).isoformat())
        if d.get("status"):
            cond.append("status=?"); args.append(str(d["status"]))
        texto = str(d.get("texto") or "").strip()
        if texto:
            cond.append("(tomador_nome LIKE ? OR tomador_doc LIKE ? OR numero = ?)"); args += ["%" + texto + "%", _digitos(texto) + "%" if _digitos(texto) else "-", _digitos(texto) or "-"]
        onde = " AND ".join(cond)
        pagina = max(0, int(d.get("pagina") or 0))
        tot = self.banco.q(f"SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status='emitida' THEN valor END), 0) AS v, SUM(status='emitida') AS e FROM notas WHERE {onde}", args, um=True)
        linhas = self.banco.q(f"SELECT * FROM notas WHERE {onde} ORDER BY criado_em DESC LIMIT 50 OFFSET ?", args + [pagina * 50])
        return {"notas": [self._resumo(r) for r in linhas], "total": tot["n"], "emitidas": tot["e"] or 0, "valorEmitido": round(tot["v"] or 0, 2), "pagina": pagina}

    def acao_situacao(self, d, usuario):
        ids = [str(x) for x in (d.get("ids") or [])][:300]
        if not ids:
            return {"notas": []}
        linhas = self.banco.q(f"SELECT * FROM notas WHERE id IN ({','.join('?' * len(ids))})", ids)
        return {"notas": [self._resumo(r) for r in linhas]}

    def acao_nota(self, d, usuario):
        r = self.banco.q("SELECT * FROM notas WHERE id=?", (str(d.get("id")),), um=True)
        if not r:
            raise ErroNota("Nota não encontrada neste robô.")
        return {"nota": self._resumo(r), "pedido": json.loads(r["pedido"])}

    def acao_xml(self, d, usuario):
        import gzip
        r = self.banco.q("SELECT numero, chave, xml, cnpj FROM notas WHERE id=?", (str(d.get("id")),), um=True)
        if not r or not r["xml"]:
            raise ErroNota("Essa nota ainda não tem XML.")
        return {"nome": f"NFSe_{(r['numero'] or r['chave'] or 'nota').zfill(6)}.xml", "base64": base64.b64encode(gzip.decompress(r["xml"])).decode()}

    def acao_reenviar(self, d, usuario):
        r = self.banco.q("SELECT * FROM notas WHERE id=?", (str(d.get("id")),), um=True)
        if not r:
            raise ErroNota("Nota não encontrada.")
        if r["status"] not in ("erro", "descartada"):
            raise ErroNota("Só dá para reenviar nota com erro.")
        pedido = json.loads(r["pedido"])
        if d.get("pedido"):  # corrigida na tela
            emit = self.emitente(r["cnpj"])
            serv = {s["id"]: s for s in self.servicos(r["cnpj"])}.get(str(d["pedido"].get("servicoId") or pedido.get("servicoId")))
            if not serv:
                raise ErroNota("Escolha um serviço cadastrado.")
            pedido = limpar_pedido(emit, serv, d["pedido"])
        t = pedido.get("tomador") or {}
        self.banco.x("UPDATE notas SET status='fila', erro=NULL, pedido=?, valor=?, tomador_doc=?, tomador_nome=?, atualizado_em=? WHERE id=?",
                     (json.dumps(pedido, ensure_ascii=False), float(pedido["valor"]), t.get("doc"), t.get("nome"), _agora_iso(), r["id"]))
        self.acordar.set()
        return {"ok": True}

    def acao_descartar(self, d, usuario):
        self.banco.x("UPDATE notas SET status='descartada', atualizado_em=? WHERE id=? AND status='erro'", (_agora_iso(), str(d.get("id"))))
        return {"ok": True}

    # ---------- fila: envia uma nota de cada vez ----------
    def _contexto(self, cnpj):
        usado, guardado = certificado_para(cnpj)
        if not guardado:
            raise ErroNota("O certificado A1 dessa empresa não está no robô (aba Certificados).")
        c = self._contextos.get(usado)
        if not c or time.time() - c[1] > 600:
            c = (contexto_com_certificado(guardado), time.time())
            self._contextos[usado] = c
        return c[0], guardado

    def rodar(self):
        log(f"Emissão de NFS-e Nacional pronta (banco: {ARQ_BANCO}).")
        while not self.parar.is_set():
            r = self.banco.q("SELECT * FROM notas WHERE status IN ('verificar','fila') ORDER BY criado_em LIMIT 1", um=True)
            if not r:
                self._talvez_backup()
                self.acordar.wait(30)
                self.acordar.clear()
                continue
            try:
                self.enviar(r)
            except Exception as e:  # noqa: BLE001
                log(f"Emissão: erro inesperado ({e})")
                log(traceback.format_exc())
                self.banco.x("UPDATE notas SET status='erro', erro=?, atualizado_em=? WHERE id=?", (f"Erro no robô: {e}"[:1500], _agora_iso(), r["id"]))

    def enviar(self, r):
        nid, cnpj = r["id"], r["cnpj"]
        pedido = json.loads(r["pedido"])
        emit = self.emitente(cnpj)
        ambiente = r["ambiente"]
        if not emit:
            raise ErroNota("Empresa sem configuração de emissão.")
        try:
            ctx, guardado = self._contexto(cnpj)
        except ErroNota as e:
            self.banco.x("UPDATE notas SET status='erro', erro=?, atualizado_em=? WHERE id=?", (str(e), _agora_iso(), nid))
            return
        if guardado.get("validade") and guardado["validade"] < dt.date.today().isoformat():
            self.banco.x("UPDATE notas SET status='erro', erro=?, atualizado_em=? WHERE id=?", ("O certificado A1 dessa empresa venceu. Guarde o novo no Agente e reenvie.", _agora_iso(), nid))
            return
        sefin = Sefin(ambiente, ctx)
        serie = r["serie"] or emit["serie"]
        ndps = r["ndps"]
        precisa_conferir = r["status"] == "verificar" or bool(ndps)
        if not ndps:
            ndps = self.proximo_numero(cnpj, ambiente, serie)
        for _pulo in range(MAX_NUMEROS_PULADOS + 1):
            ident = id_da_dps(emit, serie, ndps)
            self.banco.x("UPDATE notas SET status='enviando', serie=?, ndps=?, id_dps=?, tentativas=tentativas+1, atualizado_em=? WHERE id=?",
                         (serie, ndps, ident, _agora_iso(), nid))
            self._numero_usado(cnpj, ambiente, serie, ndps)
            try:
                existe = sefin.dps_existe(ident)
                if existe:
                    chave = sefin.chave_da_dps(ident)
                    xml = sefin.xml_da_nfse(chave) if chave else None
            except ErroNota as e:
                self.banco.x("UPDATE notas SET status='erro', erro=?, atualizado_em=? WHERE id=?", (str(e), _agora_iso(), nid))
                return
            except (ConnectionError, OSError) as e:
                return self._sem_conexao(nid, e)
            if not existe:
                break
            if precisa_conferir and _mesma_nota(xml, pedido) is not False:
                return self._emitida(nid, xml, chave, ["A Sefin já tinha esta nota (a resposta anterior se perdeu): não emiti de novo."])
            log(f"Emissão: DPS nº {ndps} já é de outra nota; usando o próximo número.")
            ndps += 1
            precisa_conferir = False
        else:
            self.banco.x("UPDATE notas SET status='erro', erro=?, atualizado_em=? WHERE id=?",
                         (f"Os {MAX_NUMEROS_PULADOS} números de DPS seguintes já estão usados. Ajuste o 'próximo número da DPS' na configuração da empresa.", _agora_iso(), nid))
            return
        dps, _ = montar_dps(emit, pedido, serie, ndps, ambiente)
        conteudo = base64.b64decode(abrir(guardado["pfx"]))
        _info, chave_privada, cert, _extras = ler_certificado(conteudo, abrir(guardado["senha"]))
        xml_assinado = assinar_dps(dps, chave_privada, cert)
        try:
            resp = sefin.emitir(xml_assinado)
        except ErroNota as e:
            self.banco.x("UPDATE notas SET status='erro', erro=?, atualizado_em=? WHERE id=?", (str(e), _agora_iso(), nid))
            return
        except (ConnectionError, OSError, TimeoutError) as e:
            return self._sem_conexao(nid, e)
        if resp["ok"]:
            return self._emitida(nid, resp["xml"], resp["chave"], resp.get("alertas"))
        erro = resp["erro"]
        if "E1235" in erro and "finNFSe" in erro:
            erro += " — a Sefin parece estar usando outro leiaute. Na configuração da empresa, troque o campo 'Leiaute'."
        log(f"Emissão recusada pela Sefin (DPS {ndps}): {erro[:200]}")
        self.banco.x("UPDATE notas SET status='erro', erro=?, atualizado_em=? WHERE id=?", (erro, _agora_iso(), nid))

    def _numero_usado(self, cnpj, ambiente, serie, ndps):
        self.banco.x("""INSERT INTO numeracao (cnpj, ambiente, serie, proximo) VALUES (?, ?, ?, ?)
                        ON CONFLICT(cnpj, ambiente, serie) DO UPDATE SET proximo=MAX(proximo, excluded.proximo)""", (cnpj, ambiente, serie, ndps + 1))

    def _emitida(self, nid, xml, chave, alertas=None):
        import gzip
        numero = _numero_no_xml(xml) or (chave[23:36].lstrip("0") if chave and len(chave) == 50 else None)
        self.banco.x("UPDATE notas SET status='emitida', chave=?, numero=?, emitida_em=?, xml=?, erro=NULL, alertas=?, atualizado_em=? WHERE id=?",
                     (chave, numero, _agora_iso(), gzip.compress(xml) if xml else None, json.dumps(alertas or [], ensure_ascii=False), _agora_iso(), nid))
        log(f"NFS-e emitida: nº {numero} (chave {chave}).")

    def _sem_conexao(self, nid, e):
        """Sem resposta: NÃO marca erro (a nota pode ter saído). Volta para conferir e tenta de novo daqui a pouco."""
        r = self.banco.q("SELECT tentativas FROM notas WHERE id=?", (nid,), um=True)
        espera = min(300, 10 * (r["tentativas"] if r else 1))
        msg = f"Sem resposta da Sefin ({e}). O robô confere e tenta de novo sozinho."
        log("Emissão: " + msg)
        self.banco.x("UPDATE notas SET status='verificar', erro=?, atualizado_em=? WHERE id=?", (msg[:500], _agora_iso(), nid))
        self.parar.wait(espera)

    # ---------- backup diário (para o Prumo guardar no R2) ----------
    def _talvez_backup(self):
        """Com a fila parada: manda o backup se houver algo novo e o último tiver mais de 4 h (ou for de outro dia)."""
        if time.time() - self.ultimo_backup_tentado < min(1800, BACKUP_HORAS * 3600) or not hasattr(self, "prumo") or not self.prumo.vinculado:
            return
        desde = self.banco.ajuste("backup_desde") or ""
        agora = dt.datetime.now(FUSO_BRASILIA)
        if desde:
            ultimo = dt.datetime.fromisoformat(desde)
            novidade = self.banco.q("SELECT 1 FROM notas WHERE atualizado_em >= ? LIMIT 1", (desde,), um=True) or \
                self.banco.q("SELECT 1 FROM emitentes WHERE atualizado_em >= ? UNION SELECT 1 FROM servicos WHERE atualizado_em >= ? LIMIT 1", (desde, desde), um=True)
            if not novidade or (agora - ultimo < dt.timedelta(hours=BACKUP_HORAS) and ultimo.date() == agora.date()):
                return
        self.ultimo_backup_tentado = time.time()
        try:
            self.fazer_backup(agora.strftime("%Y-%m-%d-%H%M"))
        except Exception as e:  # noqa: BLE001
            log(f"Backup da emissão não foi enviado ({e}); tento de novo em 30 min.")

    def fazer_backup(self, hoje):
        """Cadastros inteiros + notas que mudaram desde o último backup (o Prumo guarda no R2). Também guarda
        uma cópia do banco aqui mesmo (uma por dia, últimos 7 dias)."""
        import gzip
        import sqlite3
        desde = self.banco.ajuste("backup_desde") or ""
        agora = _agora_iso()
        pacote = {"versao": 1, "geradoEm": agora, "desde": desde,
                  "emitentes": [dict(r) for r in self.banco.q("SELECT * FROM emitentes")],
                  "numeracao": [dict(r) for r in self.banco.q("SELECT * FROM numeracao")],
                  "servicos": [dict(r) for r in self.banco.q("SELECT * FROM servicos")],
                  "tomadores": [dict(r) for r in self.banco.q("SELECT * FROM tomadores")],
                  "notas": [{**dict(r), "xml": base64.b64encode(r["xml"]).decode() if r["xml"] else None}
                            for r in self.banco.q("SELECT * FROM notas WHERE atualizado_em >= ?", (desde,))]}
        dados = gzip.compress(json.dumps(pacote, ensure_ascii=False).encode("utf-8"))
        if len(dados) > 60_000_000:
            raise RuntimeError("backup grande demais para mandar de uma vez")
        self.prumo._pedir("/api/robo/backup", {"nome": f"emissao-{hoje}.json.gz", "base64": base64.b64encode(dados).decode()}, timeout=300)
        pasta = os.path.join(PASTA, "backups")
        os.makedirs(pasta, exist_ok=True)
        destino = sqlite3.connect(os.path.join(pasta, f"prumo-{hoje[:10]}.db"))
        with self.banco.trava:
            self.banco.con.backup(destino)
        destino.close()
        for antigo in sorted(f for f in os.listdir(pasta) if f.startswith("prumo-"))[:-7]:
            try:
                os.remove(os.path.join(pasta, antigo))
            except OSError:
                pass
        self.banco.ajuste("backup_desde", agora)
        log(f"Backup da emissão enviado ao Prumo ({len(pacote['notas'])} nota(s) novas/alteradas, {len(dados) // 1024} KB).")


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
    # "Indicador da IE do Destinatário" (1 = Contribuinte ICMS, 2 = isento, 9 = Não Contribuinte) — caminho passado pelo escritório
    "indicador_ie": "//*[@id=\"app\"]/div[1]/div/div[2]/div[1]/div[1]/div[2]/div[6]/div[1]/div/select",
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
            log("Destinatário sem inscrição estadual: “9 - Não Contribuinte” e IE em branco.")
        self._indicador_ie("9" if sem_ie else "1")
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

    def _indicador_ie(self, codigo):
        """Escolhe o “Indicador da IE do Destinatário”: '1' (tem IE) ou '9' (Não Contribuinte)."""
        from selenium.webdriver.support.ui import Select
        nome = {"1": "Contribuinte ICMS", "9": "Não Contribuinte"}[codigo]
        candidatos = []
        try:
            candidatos.append(self._achar(self.sel.get("indicador_ie") or SELETORES_PADRAO["indicador_ie"], tempo=8))
        except PassoFalhou:
            pass
        try:  # reserva: pelo nome do campo na tela
            candidatos += self.driver.find_elements("xpath", "//label[contains(normalize-space(.), 'Indicador da IE')]/following::select[1]")
        except Exception:  # noqa: BLE001
            pass
        for el in candidatos:
            try:
                sel = Select(el)
                op = next((o for o in sel.options if o.text.strip().startswith(codigo + " ")), None)
                if not op:
                    continue
                if sel.first_selected_option.text.strip() != op.text.strip():
                    sel.select_by_visible_text(op.text)
                    time.sleep(0.8)
                log(f"Indicador da IE: {op.text.strip()[:40]}…")
                return True
            except Exception:  # noqa: BLE001
                continue
        if codigo == "9":
            raise PassoFalhou("Não consegui escolher “9 - Não Contribuinte” no Indicador da IE do Destinatário.")
        log(f"Não achei o Indicador da IE (sigo com o que veio marcado: {nome}).")
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
class CanalPrumo(threading.Thread):
    """Conexão direta com o Prumo (WebSocket): o Prumo AVISA quando há nota/consulta, e o robô
    não precisa ficar perguntando. Se cair, reconecta sozinho; enquanto estiver fora, o robô
    volta a perguntar de tempos em tempos (como antes). Precisa do pacote websocket-client."""

    def __init__(self, agente):
        super().__init__(daemon=True)
        self.agente = agente
        self.app = None
        self.substituido = False
        self._avisou = set()

    def _avisar_uma_vez(self, chave, msg):
        if chave not in self._avisou:
            self._avisou.add(chave)
            log(msg)

    def run(self):
        try:
            import websocket  # pacote websocket-client
        except ImportError:
            log("Conexão direta desligada: falta o pacote websocket-client (rode: pip install -r requirements.txt). "
                "O robô continua funcionando, perguntando ao Prumo de tempos em tempos.")
            return
        ag = self.agente
        espera = 5
        while not ag.parar.is_set():
            if not ag.prumo.vinculado:
                ag.parar.wait(5)
                continue
            cfg = ag.prumo.cfg
            base = cfg["url"].rstrip("/")
            url = ("wss://" + base[8:] if base.startswith("https://") else "ws://" + base[7:] if base.startswith("http://") else base)
            url += f"/api/robo/conectar?instancia={ag.instancia}&versao={VERSAO}"
            self.substituido = False
            estado = {"abriu": False, "status": None}

            def ao_abrir(_ws):
                estado["abriu"] = True
                ag.conectado = True
                self._avisou.discard("caiu")
                log("Conectado ao Prumo (conexão direta: as notas chegam na hora, sem ficar perguntando).")
                ag.acordar.set()  # confere se ficou algo na fila enquanto estava desconectado
                ag.ao_mudar()

            def ao_receber(_ws, msg):
                try:
                    tipo = json.loads(msg).get("tipo")
                except ValueError:
                    return
                if tipo == "tarefa":
                    ag.acordar.set()
                elif tipo == "emitentes":
                    ag.recarregar_emitentes.set()
                    ag.acordar.set()
                elif tipo == "outra_copia":
                    self.substituido = True
                elif tipo == "pedido":
                    # pedido da tela de emissão: responde pelo mesmo canal (em outra linha de execução)
                    threading.Thread(target=self._responder, args=(json.loads(msg),), daemon=True).start()

            def ao_fechar(_ws, codigo, _motivo):
                if codigo == 4001:
                    self.substituido = True

            def ao_erro(_ws, erro):
                estado["status"] = getattr(erro, "status_code", None)

            self.app = websocket.WebSocketApp(url, header=[f"Authorization: Bearer {abrir(cfg['token'])}", f"User-Agent: AgentePrumo/{VERSAO}"],
                                              on_open=ao_abrir, on_message=ao_receber, on_close=ao_fechar, on_error=ao_erro)
            try:
                # pings do protocolo a cada 50 s mantêm a conexão viva (não contam no limite da Cloudflare)
                self.app.run_forever(ping_interval=50, ping_timeout=20, sslopt={"context": contexto_ssl()})
            except Exception as e:  # noqa: BLE001
                estado["status"] = estado["status"] or str(e)[:80]
            ag.conectado = False
            ag.ao_mudar()
            if ag.parar.is_set():
                break
            if self.substituido:
                log("ATENÇÃO: o Agente foi aberto em outro lugar com este mesmo vínculo; esta cópia saiu da conexão direta. Feche uma das duas.")
                ag.parar.wait(600)
                continue
            if estado["status"] == 501:
                self._avisar_uma_vez("501", "O Prumo ainda não tem a conexão direta ligada (wrangler.toml). O robô segue perguntando de tempos em tempos.")
                ag.parar.wait(1800)
                continue
            if estado["abriu"]:
                self._avisar_uma_vez("caiu", "Conexão direta com o Prumo caiu; reconectando…")
                espera = 5
            else:
                espera = min(300, espera * 2)
            ag.acordar.set()  # enquanto reconecta, o robô volta a perguntar
            ag.parar.wait(espera)

    def _responder(self, pedido):
        resposta = {"tipo": "resposta", "id": pedido.get("id")}
        emissao = self.agente.emissao
        try:
            if emissao is None:
                raise ErroNota("A emissão não está ligada neste robô: rode  pip install -r requirements.txt  e abra o Agente de novo.")
            resposta.update(ok=True, dados=emissao.atender(str(pedido.get("acao") or ""), pedido.get("dados") or {}, pedido.get("usuario") or "?"))
        except ErroNota as e:
            resposta.update(ok=False, erro=str(e))
        except Exception as e:  # noqa: BLE001
            log(f"Pedido da emissão falhou: {e}")
            log(traceback.format_exc())
            resposta.update(ok=False, erro=f"Erro no robô: {e}")
        try:
            self.app.send(json.dumps(resposta, ensure_ascii=False))
        except Exception as e:  # noqa: BLE001
            log(f"Não consegui responder ao Prumo ({e}).")

    def fechar(self):
        try:
            self.app and self.app.close()
        except Exception:  # noqa: BLE001
            pass


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
        # identifica ESTA cópia do Agente: se outra cópia (ex.: antiga) estiver aberta com o mesmo vínculo,
        # o Prumo dá as tarefas só para a que abriu por último e não grava a cada pergunta
        import uuid
        self.instancia = uuid.uuid4().hex
        self.inicio = True
        self.trabalhando = False
        self.sair_pedido = threading.Event()  # outra cópia (mais nova) pediu para esta fechar
        self.conectado = False                 # conexão direta (WebSocket) com o Prumo ativa
        self.ao_sair = lambda: None
        self._avisou_copia = 0
        self.emissao = None                    # emissão de NFS-e Nacional (banco deste computador)
        try:
            import lxml  # noqa: F401
            import cryptography  # noqa: F401
            self.emissao = EmissaoNacional(self.parar)
            self.emissao.prumo = self.prumo
        except ImportError:
            log("Emissão de NFS-e desligada: faltam pacotes (rode: pip install -r requirements.txt).")

    def intervalo(self):
        if self.conectado:
            return 1800  # o Prumo avisa quando houver pedido; só uma conferência de segurança a cada 30 min
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
        self.canal = CanalPrumo(self)
        self.canal.start()
        if self.emissao:
            threading.Thread(target=self.emissao.rodar, daemon=True).start()
        while not self.parar.is_set():
            if self.sair_pedido.is_set():
                log("Uma cópia mais nova do Agente foi aberta neste computador; esta cópia vai fechar.")
                self.parar.set()
                self.canal.fechar()
                self.ao_sair()
                break
            if not self.prumo.vinculado:
                self._mudar("não vinculado")
                self.acordar.wait(5)
                self.acordar.clear()
                continue
            try:
                if self.recarregar_emitentes.is_set():
                    self.recarregar_emitentes.clear()
                    quer_emitentes = True
                r = self.prumo.ciclo(sorted(senhas_guardadas().keys()), quer_emitentes=quer_emitentes, instancia=self.instancia, inicio=self.inicio, conectado=self.conectado)
                self.inicio = False
                falhas = 0
                if r.get("duasCopias"):
                    if time.time() - self._avisou_copia > 600:
                        log("ATENÇÃO: o Agente Prumo está aberto em outro lugar com este mesmo vínculo (outra janela ou outro computador). "
                            "Esta cópia fica parada. Feche uma das duas.")
                        self._avisou_copia = time.time()
                    self._mudar("outra cópia aberta")
                    self.acordar.wait(60)
                    self.acordar.clear()
                    continue
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
                    self.trabalhando = True
                    try:
                        self.executar(r["tarefa"])
                    finally:
                        self.trabalhando = False
                    if not self.conectado:
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
            if self.sair_pedido.is_set():
                log("Uma cópia mais nova do Agente foi aberta neste computador; esta cópia vai fechar.")
                self.parar.set()
                self.canal.fechar()
                self.ao_sair()
                break
            espera = min(120, 10 * falhas) if falhas else self.intervalo()
            self.acordar.wait(espera)
            self.acordar.clear()

    def executar(self, tarefa):
        self._mudar("trabalhando")
        log(f"Tarefa recebida: {tarefa['tipo']} ({tarefa['id'][:8]})")
        resultado = None
        try:
            if tarefa["tipo"] == "nfse_nacional":
                resultado = buscar_nfse_nacional(tarefa, self.parar)
            elif tarefa["tipo"] not in ("nfae", "nfae_consulta"):
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
            resultado = {"status": "erro", "mensagem": f"Erro no robô: {e}" if tarefa.get("tipo") == "nfse_nacional" else f"Erro inesperado no robô: {e}. Confira no portal se a nota saiu."}
        for tentativa in range(5):  # o resultado precisa chegar: tenta algumas vezes
            try:
                self.prumo.resultado(tarefa["id"], resultado["status"], resultado.get("mensagem", ""), resultado.get("numero"), resultado.get("arquivos", []), resultado.get("resumo"))
                log(f"Resultado enviado: {resultado['status']} — {resultado.get('mensagem', '')}")
                if tarefa.get("tipo") == "nfse_nacional":
                    for caminho in resultado.get("arquivos", []):  # o ZIP já está no Prumo (as notas continuam guardadas aqui)
                        try:
                            os.remove(caminho)
                        except OSError:
                            pass
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
    if not garantir_copia_unica(agente):
        messagebox.showwarning("Agente Prumo", "Outro Agente Prumo continua aberto e trabalhando neste computador.\n\nEspere ele terminar a nota (ou feche-o pelo ícone perto do relógio) e abra de novo.")
        raiz.destroy()
        return
    agente.ao_sair = lambda: raiz.after(0, raiz.destroy)

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
        status_var.set(agente.estado.upper() + (" · CONEXÃO DIRETA" if agente.conectado and agente.estado == "online" else ""))
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

    # ----- Aba Certificados (NFS-e Nacional) -----
    f_cert = ttk.Frame(abas, padding=16)
    abas.add(f_cert, text="Certificados")
    ttk.Label(f_cert, text="Certificados A1 das empresas (NFS-e Nacional)", style="Titulo.TLabel").pack(anchor="w")
    ttk.Label(f_cert, text="O arquivo e a senha ficam protegidos pelo Windows só neste computador; o Prumo só vê o CNPJ, o nome e a validade. "
                           "Serve para baixar no Portal Nacional as notas emitidas (página XML NFS-e do Prumo).",
              style="Suave.TLabel", justify="left", wraplength=580).pack(anchor="w", fill="x", pady=(2, 6))
    lista_cert = ttk.Frame(f_cert)

    def adicionar_certificado():
        from tkinter import filedialog, simpledialog
        caminho = filedialog.askopenfilename(parent=raiz, title="Escolha o certificado A1 da empresa",
                                             filetypes=[("Certificado A1", "*.pfx *.p12"), ("Todos os arquivos", "*.*")])
        if not caminho:
            return
        senha = simpledialog.askstring("Senha do certificado", f"Senha do certificado\n{os.path.basename(caminho)}", show="•", parent=raiz)
        if senha is None:
            return
        try:
            with open(caminho, "rb") as f:
                conteudo = f.read()
            info = guardar_certificado(conteudo, senha)
        except Exception as e:  # noqa: BLE001
            messagebox.showerror("Agente Prumo", f"Não deu para guardar o certificado: {e}")
            return
        log(f"Certificado guardado: {info['nome'] or info['cnpj']} (válido até {info['validade'][8:10]}/{info['validade'][5:7]}/{info['validade'][:4]}).")
        desenhar_certificados()
        agente.acordar.set()  # avisa o Prumo que esta empresa já pode ser buscada
        messagebox.showinfo("Agente Prumo", f"Certificado de “{info['nome'] or info['cnpj']}” guardado.\n\nSe quiser, pode apagar o arquivo .pfx da pasta onde estava: o robô já tem uma cópia protegida.")

    ttk.Button(f_cert, text="Adicionar certificado A1 (.pfx)…", command=adicionar_certificado).pack(anchor="e", pady=(0, 8))
    lista_cert.pack(fill="both", expand=True)

    def desenhar_certificados():
        for w in lista_cert.winfo_children():
            w.destroy()
        todos = certificados_guardados()
        if not todos:
            ttk.Label(lista_cert, text="Nenhum certificado guardado ainda.", style="Suave.TLabel").pack(anchor="w")
            return
        hoje = dt.date.today().isoformat()
        daqui30 = (dt.date.today() + dt.timedelta(days=30)).isoformat()
        for cnpj, c in sorted(todos.items(), key=lambda x: x[1].get("nome", "")):
            linha = ttk.Frame(lista_cert)
            linha.pack(fill="x", pady=5)
            nomes = ttk.Frame(linha)
            nomes.pack(side="left", fill="x", expand=True)
            ttk.Label(nomes, text=c.get("nome") or cnpj).pack(anchor="w")
            v = c.get("validade") or ""
            venc = f"{v[8:10]}/{v[5:7]}/{v[:4]}" if v else "?"
            situacao, cor = ("VENCIDO em " + venc, "#B23B29") if v and v < hoje else (("vence em " + venc, "#B4532A") if v and v < daqui30 else ("válido até " + venc, "#3E6B37"))
            doc = f"{cnpj[:2]}.{cnpj[2:5]}.{cnpj[5:8]}/{cnpj[8:12]}-{cnpj[12:]}"
            ttk.Label(nomes, text=f"{doc}  ·  {situacao}", style="Suave.TLabel", foreground=cor).pack(anchor="w")

            def apagar(x=cnpj, nome=c.get("nome") or cnpj):
                if messagebox.askyesno("Agente Prumo", f"Apagar o certificado de “{nome}” deste computador?"):
                    apagar_certificado(x)
                    desenhar_certificados()
                    agente.acordar.set()

            ttk.Button(linha, text="Apagar", command=apagar).pack(side="left", padx=(6, 0))

    desenhar_certificados()

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


PORTA_TRAVA = 47831  # só no próprio computador (127.0.0.1)


def garantir_copia_unica(agente):
    """Só um Agente por computador. Se já houver um aberto, pede para ele fechar (ele termina a nota que
    estiver fazendo) e espera; assim, abrir a versão nova fecha a antiga sozinho."""
    import socket

    def ouvir(srv):
        while True:
            try:
                con, _ = srv.accept()
                with con:
                    if con.recv(16).strip() == b"sair":
                        agente.sair_pedido.set()
                        agente.acordar.set()
                        con.sendall(b"ok")
            except Exception:  # noqa: BLE001
                time.sleep(1)

    fim = time.time() + 150
    pediu = False
    while True:
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            srv.bind(("127.0.0.1", PORTA_TRAVA))
            srv.listen(2)
            threading.Thread(target=ouvir, args=(srv,), daemon=True).start()
            return True
        except OSError:
            srv.close()
        if not pediu:
            log("Já existe um Agente Prumo aberto neste computador; pedindo para ele fechar…")
            try:
                with socket.create_connection(("127.0.0.1", PORTA_TRAVA), timeout=3) as c:
                    c.sendall(b"sair")
            except OSError:
                pass
            pediu = True
        if time.time() > fim:
            return False
        time.sleep(2)


def sem_janela():
    """Modo console (testes/servidor): vínculo por linha de comando."""
    agente = Agente()
    if "--uma-vez" not in sys.argv and not garantir_copia_unica(agente):
        log("Outro Agente Prumo continua aberto e ocupado. Feche-o e abra de novo.")
        return
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
