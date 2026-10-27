// ============================================================================
// parcelamentos-leitor.js — lê os extratos de parcelamento (texto vindo do pdf.js)
// e monta um "acordo" com parcelas pagas/em aberto. Sem acesso à tela: dá para
// testar no Node.
//
// Formatos reconhecidos:
//  • e-CAC  "Consulta Pedidos de Parcelamento - <tipo>"   (pedido, consolidação, pagamentos)
//  • e-CAC  "RECIBO DE ADESÃO AO PARCELAMENTO ..."          (débitos, total, nº e valor das parcelas)
//  • PGFN   "CONSULTA DE NEGOCIAÇÕES" (Regularize/SISPAR)  (negociação, saldo, prestações, pagamentos)
// ============================================================================
(function (raiz) {
  const num = (s) => {
    if (s == null) return null;
    const t = String(s).replace(/[^\d,.-]/g, "");
    if (!t) return null;
    const n = Number(t.replace(/\./g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  };
  const limpar = (texto) => String(texto || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const so = (re, t, g = 1) => { const m = re.exec(t); return m ? limpar(m[g]) : null; };
  const dig = (s) => String(s || "").replace(/\D/g, "");
  const fmtCnpj = (d) => d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : d.length === 11 ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4") : d;
  // dd/mm/aaaa -> aaaa-mm-dd
  const iso = (br) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(br || ""); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
  // mm/aaaa -> aaaa-mm
  const isoMes = (br) => { const m = /^(\d{2})\/(\d{4})$/.exec(br || ""); return m ? `${m[2]}-${m[1]}` : null; };

  function cnpjDoContribuinte(t) {
    // No e-CAC o PRIMEIRO CNPJ da página é o do escritório (titular do acesso) — nunca usar esse.
    const rotulos = [/CNPJ:\s*(\d{2}\.\d{3}\.\d{3}\/\d{4}[\s-]?\d{2})/, /CPF\/CNPJ Contribuinte:\s*([\d./-]{11,18})/, /Procurador de:\s*([\d./-]{11,18})/, /Usuário:\s*([\d./-]{11,18})/, /CPF:\s*(\d{3}\.\d{3}\.\d{3}-\d{2})\b(?![\s\S]*Certifica)/];
    for (const re of rotulos) { const v = so(re, t); if (v && [11, 14].includes(dig(v).length)) return fmtCnpj(dig(v)); }
    return null;
  }

  // ---------------------------------------------------------------- e-CAC: pedido
  function lerPedidoEcac(t) {
    // o título pode ter sido cortado na impressão: "Vencimento do DAS" = Simples Nacional
    const tipo = so(/Consulta Pedidos de Parcelamento\s*-\s*(.+?)\s+(?:Nome Empresarial|Voltar|CNPJ:)/i, t) || (/Vencimento do DAS/i.test(t) ? "Parcelamento do Simples Nacional" : "Parcelamento");
    const ped = /Observa[çc][ãa]o\s+(\d+)\s+(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+(\d{2}\/\d{2}\/\d{4})/i.exec(t);
    const con = /Data da consolida[çc][ãa]o\s+R\$\s*([\d.]+,\d{2})\s+(\d+)\s+R\$\s*([\d.]+,\d{2})\s+(\d{2}\/\d{2}\/\d{4})/i.exec(t);
    const pagamentos = [];
    const vistos = new Set();
    const re = /(\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+R\$\s*([\d.]+,\d{2})/g;
    let m;
    while ((m = re.exec(t))) {
      const chave = m[1] + m[3] + m[4];
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      pagamentos.push({ ref: isoMes(m[1]), vencimento: iso(m[2]), data: iso(m[3]), valor: num(m[4]) });
    }
    // "Alterações de dívida": reconsolidação (débitos alterados no sistema de cobrança, antecipação...)
    const reconsolidacoes = [];
    const reAlt = /altera[çc][ãa]o da d[íi]vida\s+R\$\s*([\d.]+,\d{2})\s+(\d+)\s+R\$\s*([\d.]+,\d{2})\s+(\d{2}\/\d{2}\/\d{4})/gi;
    let ma;
    while ((ma = reAlt.exec(t))) reconsolidacoes.push({ valor: num(ma[1]), remanescentes: Number(ma[2]), parcelaBasica: num(ma[3]), data: iso(ma[4]) });
    const ultimaAlt = reconsolidacoes[reconsolidacoes.length - 1];
    return {
      orgao: "RFB", tipo,
      reconsolidacoes,
      ...(ultimaAlt ? { parcelaBasicaOriginal: con ? num(con[3]) : null } : {}),
      numero: ped ? ped[1] : null,
      situacao: ped ? limpar(ped[3]) : null,
      dataSituacao: ped ? iso(ped[4]) : null,
      dataAdesao: ped ? iso(ped[2]) : null,
      valorConsolidado: con ? num(con[1]) : null,
      qtdParcelas: con ? Number(con[2]) : null,
      parcelaBasica: ultimaAlt ? ultimaAlt.parcelaBasica : con ? num(con[3]) : null,
      dataConsolidacao: con ? iso(con[4]) : null,
      pagamentos,
    };
  }

  // ---------------------------------------------------------------- e-CAC: recibo de adesão
  function lerReciboEcac(t) {
    const titulo = so(/RECIBO DE ADES[ÃA]O AO (PARCELAMENTO.+?)\s+Nome Empresarial/i, t) || "PARCELAMENTO";
    const tipo = titulo.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()).replace(/\b(Do|Da|De|Dos|Das|E|Ao)\b/g, (c) => c.toLowerCase());
    const debitos = [];
    const re = /(\d{2}\/\d{4})\S?\s+(\d{2}\/\d{2}\/\d{4})\s+(?:([\d./-]{5,})\s+)?R\$\s*([\d.]+,\d{2})\s+R\$\s*([\d.]+,\d{2})/g;
    let m;
    while ((m = re.exec(t))) debitos.push({ periodo: isoMes(m[1]), vencimento: iso(m[2]), processo: m[3] || null, original: num(m[4]), atualizado: num(m[5]) });
    return {
      orgao: "RFB", tipo,
      numero: null,
      dataAdesao: iso(so(/em (\d{2}\/\d{2}\/\d{4}) às/i, t)) || null,
      valorConsolidado: num(so(/Valor total parcelado:\s*R\$\s*([\d.]+,\d{2})/i, t)),
      qtdParcelas: Number(so(/N[úu]mero de parcelas\s*:\s*(\d+)/i, t)) || null,
      valorPrimeira: num(so(/Valor da primeira parcela\s*:\s*R\$\s*([\d.]+,\d{2})/i, t)),
      parcelaBasica: num(so(/Valor das demais parcelas\s*:\s*R\$\s*([\d.]+,\d{2})/i, t)),
      vencimentoPrimeira: iso(so(/primeira parcela:\s*(\d{2}\/\d{2}\/\d{4})/i, t)),
      debitos,
    };
  }

  // ---------------------------------------------------------------- PGFN
  function lerPgfn(t) {
    const adesao = so(/Data da Ades[ãa]o:\s*(\d{2}\/\d{2}\/\d{4})/i, t);
    // pagamentos: as "Ocorrências" trazem o valor total pago (a tabela costuma sair cortada na impressão)
    const pagamentos = [];
    let m;
    const reOc = /DT ARREC:\s*(\d{2}\/\d{2}\/\d{4})\s+VALOR R\$\s*([\d.]+,\d{2})/gi;
    while ((m = reOc.exec(t))) pagamentos.push({ data: iso(m[1]), valor: num(m[2]) });
    if (!pagamentos.length) {
      const reTab = /\b\d{1,3}\s+(\d{2}\/\d{2}\/\d{4})\s+Documento de Arrecada[çc][ãa]o\s+\d+\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})(?:\s+([\d.]+,\d{2}))?/gi;
      while ((m = reTab.exec(t))) pagamentos.push({ data: iso(m[1]), valor: Math.round(((num(m[2]) || 0) + (num(m[3]) || 0) + (num(m[4]) || 0) + (num(m[5]) || 0)) * 100) / 100 });
    }
    // prestações (o ano do vencimento pode ter sido cortado na impressão: deduz pela sequência)
    const parcelas = [];
    const rePr = /\b(\d{4})\s+(Entrada|Presta[çc][ãa]o\s*B[áa]sica|Presta[çc][ãa]o|Saldo|Parcela)\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+(\d{2})\/(\d{2})\/(\d{4})?/gi;
    let ano = adesao ? Number(adesao.slice(6)) : new Date().getFullYear();
    let mesAnt = adesao ? Number(adesao.slice(3, 5)) : null;
    while ((m = rePr.exec(t))) {
      const mes = Number(m[10]);
      if (m[11]) ano = Number(m[11]);
      else if (mesAnt != null && mes < mesAnt) ano++;
      mesAnt = mes;
      const tipoP = /entrada/i.test(m[2]) ? "Entrada" : "Prestação";
      parcelas.push({ n: Number(m[1]), tipo: tipoP, valor: num(m[3]), saldo: num(m[8]), vencimento: `${ano}-${m[10]}-${m[9]}` });
    }
    const negociacao = so(/Negocia[çc][õo]es:\s*(.+?)\s+Data da/i, t);
    const modalidade = so(/Modalidade:\s*(.+?)\s+(?:N[ºo°] do|Situa[çc][ãa]o:)/i, t);
    return {
      orgao: "PGFN",
      tipo: modalidade || negociacao || "Negociação PGFN",
      negociacao,
      numero: so(/N[úu]mero da Negocia[çc][ãa]o:\s*(\d+)/i, t),
      tipoNegociacao: so(/Tipo de Negocia[çc][ãa]o:\s*(.+?)\s+Data/i, t),
      situacao: so(/Situa[çc][ãa]o:\s*(.+?)\s+Principal:/i, t),
      dataSituacao: iso(so(/Data da Situa[çc][ãa]o:\s*(\d{2}\/\d{2}\/\d{4})/i, t)),
      dataAdesao: iso(adesao),
      qtdParcelas: Number(so(/Quantidade de Presta[çc][õo]es:\s*(\d+)/i, t)) || null,
      valorConsolidado: num(so(/Valor Consolidado:\s*([\d.]+,\d{2})/i, t)),
      saldoSemJuros: num(so(/Saldo Devedor sem Juros:\s*([\d.]+,\d{2})/i, t)),
      saldoDevedor: num(so(/Saldo Devedor com Juros:\s*([\d.]+,\d{2})/i, t)),
      dataLiquidacao: iso(so(/Data Liquida[çc][ãa]o Neg\.:\s*(\d{2}\/\d{2}\/\d{4})/i, t)),
      dataRescisao: iso(so(/Data da Rescis[ãa]o:\s*(\d{2}\/\d{2}\/\d{4})/i, t)),
      parcelaBasica: (parcelas.find((p) => p.tipo === "Prestação") || parcelas[0] || {}).valor || null,
      pagamentos,
      parcelas,
    };
  }

  /** Lê o texto de um PDF. Devolve { formato, cnpj, acordo } ou null se não for um extrato conhecido. */
  function lerExtratoParcelamento(texto) {
    const t = limpar(texto);
    let formato = null, acordo = null;
    if (/CONSULTA DE NEGOCIA[ÇC][ÕO]ES/i.test(t) && /N[úu]mero da Negocia[çc][ãa]o/i.test(t)) { formato = "pgfn"; acordo = lerPgfn(t); }
    else if (/Consulta Pedidos de Parcelamento/i.test(t) ||
      (/Selecione o pedido/i.test(t) && /(Demonstrativo de pagamentos|Pedido do Contribuinte|Data do pedido)/i.test(t))) { formato = "ecac-pedido"; acordo = lerPedidoEcac(t); }
    else if (/RECIBO DE ADES[ÃA]O AO PARCELAMENTO/i.test(t)) { formato = "ecac-recibo"; acordo = lerReciboEcac(t); }
    if (!acordo) return null;
    if (!acordo.valorConsolidado && !acordo.qtdParcelas && !(acordo.pagamentos || []).length && !(acordo.parcelas || []).length) return null;
    return { formato, cnpj: cnpjDoContribuinte(t), acordo };
  }

  /** Junta o que veio do PDF no acordo já guardado (mesma negociação). */
  function acharAcordo(lista, novo) {
    return (lista || []).find((a) => a.orgao === novo.orgao && (
      (a.numero && novo.numero && a.numero === novo.numero) ||
      (a.valorConsolidado && novo.valorConsolidado && Math.abs(a.valorConsolidado - novo.valorConsolidado) < 0.01 && (!a.numero || !novo.numero))
    )) || null;
  }
  function mesclarAcordo(lista, novo, { arquivo } = {}) {
    const existente = acharAcordo(lista, novo);
    const agoraIso = new Date().toISOString();
    if (!existente) {
      const a = { id: (raiz.crypto && raiz.crypto.randomUUID ? raiz.crypto.randomUUID() : String(Date.now() + Math.random())), ...novo, fontes: arquivo ? [arquivo] : [], atualizadoEm: agoraIso };
      lista.push(a);
      return { acordo: a, novo: true };
    }
    for (const [k, v] of Object.entries(novo)) {
      if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
      if (k === "tipo" && existente.tipo && /^Parcelamento$/i.test(v)) continue;
      existente[k] = v;
    }
    existente.fontes = [...new Set([...(existente.fontes || []), ...(arquivo ? [arquivo] : [])])];
    existente.atualizadoEm = agoraIso;
    return { acordo: existente, novo: false };
  }

  const mesSeguinte = (aaaaMm, n = 1) => { const [a, m] = aaaaMm.split("-").map(Number); const d = new Date(a, m - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
  const ultimoDiaMes = (aaaaMm) => { const [a, m] = aaaaMm.split("-").map(Number); return `${aaaaMm}-${String(new Date(a, m, 0).getDate()).padStart(2, "0")}`; };

  /** Números do acordo para a tela e o relatório. */
  function resumoAcordo(a, hoje = new Date()) {
    const hojeIso = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}-${String(hoje.getDate()).padStart(2, "0")}`;
    const pagamentos = a.pagamentos || [];
    let totalPago = Math.round(pagamentos.reduce((s, p) => s + (p.valor || 0), 0) * 100) / 100;
    // cadastrado à mão: o "pago" vem das parcelas marcadas como pagas
    if (!pagamentos.length && (a.parcelas || []).length) totalPago = Math.round(a.parcelas.filter((p) => !((p.saldo || 0) > 0.004)).reduce((s, p) => s + (p.valor || 0), 0) * 100) / 100;
    const r = { total: a.qtdParcelas || (a.parcelas || []).length || null, totalPago, estimado: false };
    if ((a.parcelas || []).length) {
      const abertas = a.parcelas.filter((p) => (p.saldo || 0) > 0.004);
      r.pagas = a.parcelas.length - abertas.length;
      r.abertas = abertas.length;
      r.total = r.total || a.parcelas.length;
      r.saldo = a.saldoDevedor != null && !a.manual ? a.saldoDevedor : Math.round(abertas.reduce((s, p) => s + p.saldo, 0) * 100) / 100;
      r.proxima = abertas[0] ? { vencimento: abertas[0].vencimento, valor: abertas[0].saldo || abertas[0].valor } : null;
      r.atrasadas = abertas.filter((p) => p.vencimento && p.vencimento < hojeIso).length;
      r.valorParcela = abertas.length ? abertas[abertas.length - 1].valor : a.parcelaBasica;
      r.termino = a.parcelas[a.parcelas.length - 1].vencimento;
      r.listaParcelas = a.parcelas.map((p) => ({ n: p.n, tipo: p.tipo, vencimento: p.vencimento, valor: p.valor, saldo: p.saldo, paga: !((p.saldo || 0) > 0.004), dataPagamento: p.dataPagamento || null }));
    } else {
      // Simples Nacional (e-CAC): uma parcela por mês; o valor sobe com a Selic
      const refs = [...new Set(pagamentos.map((p) => p.ref).filter(Boolean))].sort();
      r.pagas = refs.length;
      r.abertas = r.total != null ? Math.max(0, r.total - r.pagas) : null;
      const ultima = pagamentos.filter((p) => p.ref).sort((x, y) => (x.ref < y.ref ? -1 : 1)).at(-1);
      r.valorParcela = ultima ? ultima.valor : a.parcelaBasica;
      r.saldo = r.abertas != null && r.valorParcela ? Math.round(r.abertas * r.valorParcela * 100) / 100 : null;
      r.estimado = true;
      const primeiraRef = refs[0] || (a.vencimentoPrimeira ? a.vencimentoPrimeira.slice(0, 7) : a.dataConsolidacao ? a.dataConsolidacao.slice(0, 7) : null);
      if (r.abertas && (refs.length || primeiraRef)) {
        const prox = refs.length ? mesSeguinte(refs.at(-1)) : primeiraRef;
        r.proxima = { ref: prox, vencimento: ultimoDiaMes(prox), valor: r.valorParcela };
        const mesAtual = hojeIso.slice(0, 7);
        let atras = 0, m = prox;
        while (m < mesAtual && atras < 240) { atras++; m = mesSeguinte(m); }
        r.atrasadas = Math.min(atras, r.abertas);
      } else { r.proxima = null; r.atrasadas = 0; }
      r.termino = primeiraRef && r.total ? ultimoDiaMes(mesSeguinte(primeiraRef, r.total - 1)) : null;
      r.listaParcelas = [];
      if (primeiraRef && r.total) {
        const porRef = new Map(pagamentos.map((p) => [p.ref, p]));
        for (let i = 0; i < r.total; i++) {
          const ref = mesSeguinte(primeiraRef, i), p = porRef.get(ref);
          r.listaParcelas.push({ n: i + 1, tipo: i === 0 && a.valorPrimeira ? "1ª parcela" : "Parcela", ref, vencimento: p ? p.vencimento : ultimoDiaMes(ref), valor: p ? p.valor : r.valorParcela, paga: !!p, dataPagamento: p ? p.data : null });
        }
      }
    }
    const sit = String(a.situacao || "");
    r.status = /RESCIN|RESCIS|CANCELAD|EXCLU|INDEFERID|SEM EFEITO|ENCERRAD.*RESC/i.test(sit) || a.dataRescisao ? "rescindido"
      : (r.abertas === 0 && r.total) || /LIQUIDAD|QUITAD|ENCERRAD|CONCLU/i.test(sit) || a.dataLiquidacao ? "quitado"
      : r.atrasadas > 0 ? "atraso" : "em_dia";
    r.progresso = r.total ? Math.min(1, (r.pagas || 0) / r.total) : 0;
    return r;
  }

  /** Parcelas de um parcelamento cadastrado à mão: mensais a partir do 1º vencimento; as "jaPagas" primeiras saem pagas. */
  function gerarParcelasManuais({ qtd, valor, primeiroVencimento, jaPagas = 0, valorPrimeira = null }) {
    const lista = [];
    const [a, m, d] = String(primeiroVencimento || "").split("-").map(Number);
    if (!qtd || !a) return lista;
    for (let i = 0; i < qtd; i++) {
      const ult = new Date(a, m - 1 + i + 1, 0).getDate();
      const dt = new Date(a, m - 1 + i, Math.min(d, ult));
      const venc = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
      const v = i === 0 && valorPrimeira ? valorPrimeira : valor;
      lista.push({ n: i + 1, tipo: "Parcela", valor: v, vencimento: venc, saldo: i < jaPagas ? 0 : v });
    }
    return lista;
  }

  const api = { lerExtratoParcelamento, mesclarAcordo, acharAcordo, resumoAcordo, gerarParcelasManuais };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(raiz, api);
})(typeof window !== "undefined" ? window : globalThis);
