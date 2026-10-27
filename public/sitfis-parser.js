// ============================================================================
// sitfis-parser.js — leitura do Relatório de Situação Fiscal (SITFIS / e-CAC)
//
// O relatório é dividido em SEÇÕES com título seguido de "______". A Receita já diz,
// pelo título, se aquilo é PENDÊNCIA (impede a certidão) ou EXIGIBILIDADE SUSPENSA
// (não impede: parcelado, negociado, a vencer, decisão judicial). Este leitor:
//   1. remove cabeçalho/rodapé que se repetem em toda página;
//   2. corta o texto nas seções pelos títulos;
//   3. lê cada seção com a regra própria dela;
//   4. junta débitos/inscrições ao parcelamento a que pertencem.
// Funciona no navegador e no Node (para testes).
// ============================================================================
(function (raiz) {
  "use strict";

  const RE_INSCRICAO = /\d{2}\.\d\.\d{2}\.\d{6}-\d{2}/;
  const RE_PROCESSO = /\d{5}\.\d{3}\.\d{3}\/\d{4}-\d{2}/;
  const RE_VALOR = /\d{1,3}(?:\.\d{3})*,\d{2}/;
  const RE_DATA = /\d{2}\/\d{2}\/\d{4}/;

  function valorNum(s) { return s ? parseFloat(String(s).replace(/\./g, "").replace(",", ".")) || 0 : 0; }
  function limpar(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

  // ------------------------------------------------------------------ limpeza
  function removerRuido(texto) {
    return String(texto || "")
      // cabeçalho de cada página (termina no nome da empresa, que vem antes de um espaço duplo)
      .replace(/MINIST[ÉE]RIO DA (?:ECONOMIA|FAZENDA)[\s\S]{0,600}?EMISS[ÃA]O DE CERTID[ÃA]O\s+CNPJ:\s+[\d.]+\s+-\s+.*?(?=\s{2,}|\n|$)/g, " ")
      .replace(/P[áa]gina:\s*\d+\s*\/\s*\d+/gi, " ")
      .replace(/\r/g, "");
  }

  const RE_TITULO = /^(Pend[êe]ncia\s*[-–]|D[ée]bito com Exig|Parcelamento com Exig|Inscri[çc][ãa]o com Exig|Processo com Exig|Processo\b|Diagn[óo]stico Fiscal|Dados Cadastrais|S[óo]cios e Adm|Certid[ãa]o Emitida|Final do Relat|Benef[íi]cio|Arrolamento|A[çc][õo]es Judiciais|Omiss[ãa]o)/i;

  // Corta em seções: cada pedaço entre "_____" termina (ou é) o título da próxima seção.
  function separarSecoes(textoLimpo) {
    const pedacos = textoLimpo.split(/_{3,}/);
    const secoes = [];
    let tituloAtual = "Início";
    for (const pedaco of pedacos) {
      const t = pedaco.replace(/\s+$/, "");
      const partes = t.split(/\s{2,}/);
      const ultimo = limpar(partes[partes.length - 1]);
      let conteudo = t, proximoTitulo = null;
      if (RE_TITULO.test(ultimo)) {
        proximoTitulo = ultimo;
        conteudo = partes.slice(0, -1).join("  ");
      }
      if (conteudo.trim()) {
        const anterior = secoes[secoes.length - 1];
        // continuação da mesma seção depois de uma virada de página (sem título novo)
        if (anterior && anterior.titulo === tituloAtual) anterior.conteudo += "  " + conteudo;
        else secoes.push({ titulo: tituloAtual, conteudo });
      }
      if (proximoTitulo) tituloAtual = proximoTitulo;
    }
    return secoes;
  }

  // ------------------------------------------------------------------ identificação
  function extrairCabecalho(texto) {
    const r = {};
    let m = /(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}:\d{2})\s+INFORMA[ÇC][ÕO]ES DE APOIO/i.exec(texto);
    if (m) r.dataRelatorio = `${m[1]} ${m[2].slice(0, 5)}`;
    m = /CNPJ:\s+[\d.]+\s+-\s+(.*?)(?=\s{2,}|\n)/.exec(texto);
    if (m) r.nome = limpar(m[1]);
    m = /Dados Cadastrais da Matriz[\s_]*CNPJ:\s*(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})/i.exec(texto);
    if (m) r.cnpj = m[1];
    m = /Situa[çc][ãa]o:\s+([A-ZÀ-Ú][A-ZÀ-Ú ]*?)\s{2,}Natureza/i.exec(texto);
    if (m) r.situacaoCadastral = limpar(m[1]);
    m = /Porte da Empresa:\s+(.*?)(?=\s+Op[çc][ãa]o pelo|\s{2,}|$)/i.exec(texto);
    if (m) r.porte = limpar(m[1]);
    return r;
  }

  // "Opção pelo Simples Nacional Inclusão Exclusão 04/06/2021 31/12/2023 01/01/2024 31/12/2025"
  // As datas alternam inclusão/exclusão em ordem cronológica.
  function extrairHistoricoOpcao(texto, rotulo) {
    const re = new RegExp(`Op[çc][ãa]o pelo ${rotulo}\\s+Inclus[ãa]o\\s+Exclus[ãa]o((?:\\s+\\d{2}\\/\\d{2}\\/\\d{4})+)`, "i");
    const m = re.exec(texto);
    if (!m) return null;
    const datas = m[1].trim().split(/\s+/);
    const periodos = [];
    for (let i = 0; i < datas.length; i += 2) periodos.push({ inicio: datas[i], fim: datas[i + 1] || null });
    return periodos;
  }

  function dataParaDate(d) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d || "");
    return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
  }

  function resumoSimples(periodos, referencia) {
    if (!periodos || !periodos.length) return null;
    const hoje = referencia || new Date();
    const ultimo = periodos[periodos.length - 1];
    const fim = dataParaDate(ultimo.fim);
    if (!ultimo.fim) return { optante: true, texto: `Optante desde ${ultimo.inicio}`, tipo: "ok" };
    if (fim && fim >= new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()))
      return { optante: true, exclusaoAgendada: ultimo.fim, texto: `Optante desde ${ultimo.inicio} — exclusão agendada para ${ultimo.fim}`, tipo: "erro" };
    return { optante: false, texto: `Excluída em ${ultimo.fim}`, tipo: "aviso" };
  }

  function extrairCertidao(texto) {
    const m = /Certid[ãa]o Emitida[\s_]*CNPJ:\s*[\d./-]+\s+(Certid[ãa]o [^:]+?):\s+([\w.]+)\s+Emiss[ãa]o:\s+(\d{2}\/\d{2}\/\d{4})\s+Data de Validade:\s+(\d{2}\/\d{2}\/\d{4})/i.exec(texto);
    if (!m) return null;
    return { tipo: limpar(m[1]), codigo: m[2], emissao: m[3], validade: m[4] };
  }

  // ------------------------------------------------------------------ tributos
  const NOMES_TRIBUTO = [
    [/^SIMPLES NAC/i, "Simples Nacional (DAS)"],
    [/CP-SEGUR/i, "INSS — contribuição dos segurados"],
    [/CP-PATRONAL/i, "INSS — patronal"],
    [/CP-TERCEIROS/i, "INSS — terceiros"],
    [/^MAED/i, null], // multas por atraso: tratadas à parte
  ];
  function nomeTributo(receita) {
    const semCodigo = receita.replace(/^\d{3,4}-\d{2}\s*-\s*/, "").trim();
    for (const [re, nome] of NOMES_TRIBUTO) if (re.test(semCodigo)) return nome || semCodigo;
    return semCodigo;
  }
  function categoriaReceita(receita) {
    const r = receita.toUpperCase();
    if (/SIMPLES/.test(r)) return "simples";
    if (/CP-|CONTR\. ?SEGUR|PREVID|SEGURADOS|PATRONAL|TERCEIROS|^4(0|1|3)\d\d-/.test(r)) return "previdenciario";
    return "demais";
  }
  const ROTULO_CATEGORIA = { simples: "Simples Nacional", previdenciario: "Previdenciário", demais: "Demais tributos" };

  // ------------------------------------------------------------------ SIEF (débitos)
  // Linha: [CÓD-NN - ]RECEITA  PA  Vencimento  valores...  SITUAÇÃO  [Notificação de lançamento: N]
  function lerDebitosSief(conteudo, suspenso) {
    const itens = [];
    const corpo = conteudo.replace(/^.*?Situa[çc][ãa]o\s{2,}/s, ""); // tira o cabeçalho da tabela
    const inicios = [...corpo.matchAll(/(?:^|\s{2,}|\s)(?=(?:\d{3,4}-\d{2}\s*-\s*\S|SIMPLES NAC\.))/g)].map((m) => m.index + m[0].length);
    const pedacos = inicios.map((ini, i) => corpo.slice(ini, inicios[i + 1] ?? corpo.length).trim()).filter(Boolean);
    for (const p of pedacos) {
      const m = /^((?:\d{3,4}-\d{2}\s*-\s*)?.+?)\s{2,}(\d{2}\/\d{2}\/\d{4}|\d{2}\/\d{4}|\d[ºo°]\s*TRIM\/\d{4}|\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+((?:[\d.]+,\d{2}\s+)*[\d.]+,\d{2})\s*(.*)$/s.exec(p);
      if (!m) continue;
      let resto = m[5] || "";
      let notificacao = null;
      const n = /Notifica[çc][ãa]o de lan[çc]amento:\s*(\d+)/i.exec(resto);
      if (n) { notificacao = n[1]; resto = resto.slice(0, n.index); }
      const valores = m[4].trim().split(/\s+/).map(valorNum);
      const receita = limpar(m[1]);
      itens.push({
        receita,
        codigo: (/^(\d{3,4}-\d{2})/.exec(receita) || [])[1] || null,
        tributo: nomeTributo(receita),
        categoria: categoriaReceita(receita),
        multaDeclaracao: /MAED/i.test(receita),
        pa: m[2],
        vencimento: m[3],
        valorOriginal: valores[0],
        valor: valores[valores.length - 1], // saldo devedor consolidado (pendência) ou saldo devedor (suspenso)
        situacao: limpar(resto) || (suspenso ? "SUSPENSO" : "DEVEDOR"),
        notificacao,
      });
    }
    return itens;
  }

  function classificarSuspensao(situacao) {
    const s = (situacao || "").toUpperCase();
    if (/VENCER/.test(s)) return { chave: "a_vencer", rotulo: "A vencer" };
    if (/PARCEL|NEGOCIA|SISPAR|TRANSA/.test(s)) return { chave: "parcelado", rotulo: "Parcelado/negociado" };
    if (/JUDIC|LIMINAR|SENTEN|A[ÇC][ÃA]O/.test(s)) return { chave: "judicial", rotulo: "Suspenso por decisão judicial" };
    if (/GARANT|DEP[ÓO]SITO|PENHORA/.test(s)) return { chave: "garantia", rotulo: "Garantido/depósito" };
    if (/ANALIS|REVIS|IMPUGN|RECURS|MANIFEST/.test(s)) return { chave: "analise", rotulo: "Em análise/recurso" };
    return { chave: "outros", rotulo: "Exigibilidade suspensa" };
  }

  // ------------------------------------------------------------------ SIDA (inscrições PGFN)
  function lerInscricoes(conteudo) {
    const itens = [];
    const partes = conteudo.split(new RegExp(`(?=${RE_INSCRICAO.source})`));
    for (const p of partes) {
      const num = RE_INSCRICAO.exec(p);
      if (!num || num.index !== 0) continue;
      const resto = p.slice(num[0].length);
      const datas = [...resto.matchAll(new RegExp(RE_DATA.source, "g"))].map((x) => x[0]);
      const proc = RE_PROCESSO.exec(resto);
      const receita = limpar(resto.split(RE_DATA)[0]);
      const sit = /Situa[çc][ãa]o:\s*(.*)$/s.exec(resto);
      const tipoDev = proc ? limpar(resto.slice(proc.index + proc[0].length).split(/Situa[çc][ãa]o:/)[0]) : "";
      itens.push({
        inscricao: num[0],
        receita,
        tributo: receita.replace(/^\d{4}-/, ""),
        categoria: categoriaReceita(receita),
        inscritoEm: datas[0] || null,
        ajuizadoEm: datas[1] && (!proc || resto.indexOf(datas[1]) < proc.index) ? datas[1] : null,
        processo: proc ? proc[0] : null,
        tipoDevedor: tipoDev || null,
        situacao: sit ? limpar(sit[1]) : "",
      });
    }
    return itens;
  }

  function descreverSituacaoInscricao(s) {
    const u = (s || "").toUpperCase();
    if (/SISPAR|NEGOCIAD|TRANSA/.test(u)) return { chave: "negociada", rotulo: "Negociada (SISPAR)" };
    if (/PARCEL/.test(u)) return { chave: "negociada", rotulo: "Parcelada" };
    if (/AJUIZADA/.test(u) && !/A SER AJUIZADA|NAO AJUIZ/.test(u)) return { chave: "ajuizada", rotulo: "Ajuizada (execução fiscal)" };
    if (/A SER AJUIZADA/.test(u)) return { chave: "a_ajuizar", rotulo: "A ser ajuizada" };
    if (/A SER COBRADA|EM COBRAN/.test(u)) return { chave: "cobranca", rotulo: "Em cobrança" };
    if (/JUDIC|SUSPENS/.test(u)) return { chave: "suspensa", rotulo: "Suspensa" };
    if (/GARANT/.test(u)) return { chave: "garantida", rotulo: "Garantida" };
    return { chave: "outros", rotulo: limpar(s) || "—" };
  }

  // ------------------------------------------------------------------ parcelamentos
  function lerSiefpar(conteudo, emAtraso) {
    const itens = [];
    const re = /Parcelamento:\s*([\d.\-]+)([\s\S]*?)(?=Parcelamento:|$)/g;
    let m;
    while ((m = re.exec(conteudo))) {
      const corpo = m[2];
      const susp = /Valor Suspenso:\s*([\d.,]+)/i.exec(corpo);
      const parcelas = /Parcelas em Atraso:\s*(\d+)/i.exec(corpo);
      const vAtraso = /Valor em Atraso:\s*([\d.,]+)/i.exec(corpo);
      const modalidade = limpar(corpo.replace(/(Valor Suspenso|Parcelas em Atraso|Valor em Atraso):\s*[\d.,]+/gi, "").replace(/CNPJ:\s*[\d./-]+/, "")) || "Parcelamento Simplificado";
      itens.push({
        orgao: "Receita Federal", sistema: "SIEFPAR", numero: m[1], modalidade,
        emAtraso: !!emAtraso || !!(parcelas && +parcelas[1] > 0),
        parcelasEmAtraso: parcelas ? +parcelas[1] : 0,
        valorEmAtraso: vAtraso ? valorNum(vAtraso[1]) : 0,
        valorSuspenso: susp ? valorNum(susp[1]) : 0,
      });
    }
    return itens;
  }

  function lerParcsn(conteudo, emAtraso) {
    const sem = conteudo.replace(/CNPJ:\s*[\d./-]+/, "");
    const parcelas = /Parcelas em atraso\s*:?\s*(\d+)/i.exec(sem);
    const descricao = limpar(sem.replace(/Parcelas em atraso\s*:?\s*\d+/i, "")) || "SIMPLES NACIONAL - EM PARCELAMENTO";
    const mei = /MEI/.test(descricao) && !/SIMPLES/.test(descricao);
    return [{
      orgao: "Receita Federal", sistema: mei ? "PARCMEI" : "PARCSN", numero: null,
      modalidade: mei ? "Parcelamento do MEI" : "Parcelamento do Simples Nacional",
      descricao,
      categoria: "simples",
      emAtraso: !!emAtraso || !!(parcelas && +parcelas[1] > 0),
      parcelasEmAtraso: parcelas ? +parcelas[1] : 0,
      valorEmAtraso: 0, valorSuspenso: 0,
    }];
  }

  // Contas SISPAR: "Conta 011192157 (Transferencia de saldo da conta 8944194) TRANSACAO ... Modalidade: SIMPLES NACIONAL ..."
  function lerSispar(conteudo, emAtraso) {
    const itens = [];
    const corpo = conteudo.replace(/CNPJ:\s*[\d./-]+/, "").replace(/^\s*Conta\b/i, " ");
    const re = /(?:^|\s)(\d{6,12})\s+([\s\S]*?)Modalidade:\s*([\s\S]*?)(?=\s\d{6,12}\s+\S|$)/g;
    let m;
    while ((m = re.exec(corpo))) {
      const descricao = limpar(m[2]);
      const modalidade = limpar(m[3]);
      const transf = /Transfer[êe]ncia de saldo da conta\s*(\d+)/i.exec(descricao);
      const cat = /SIMPLES/i.test(modalidade) ? "simples" : /PREVID/i.test(modalidade) ? "previdenciario" : /DEMAIS|N[ÃA]O PREVID/i.test(modalidade) ? "demais" : null;
      const parcelas = /Parcelas em atraso\s*:?\s*(\d+)/i.exec(m[0]);
      itens.push({
        orgao: "PGFN", sistema: "SISPAR", numero: m[1],
        tipo: /TRANSA/i.test(descricao) ? "Transação" : "Parcelamento",
        descricao: descricao.replace(/\(?Transfer[êe]ncia de saldo da conta\s*\d+\)?/i, "").trim(),
        contaOrigem: transf ? transf[1] : null,
        modalidade, categoria: cat,
        emAtraso: !!emAtraso || !!(parcelas && +parcelas[1] > 0),
        parcelasEmAtraso: parcelas ? +parcelas[1] : 0,
        valorEmAtraso: 0, valorSuspenso: 0,
        inscricoes: [],
      });
    }
    return itens;
  }

  function lerParcelamentoGenerico(titulo, conteudo, emAtraso) {
    const sistema = (/\(([^)]+)\)/.exec(titulo) || [])[1] || "Parcelamento";
    const parcelas = /Parcelas em atraso\s*:?\s*(\d+)/i.exec(conteudo);
    const vAtraso = /Valor em Atraso:\s*([\d.,]+)/i.exec(conteudo);
    const numero = (/(?:Parcelamento|Processo|Conta)\s*:?\s*([\d./-]{6,})/i.exec(conteudo) || [])[1] || null;
    return [{
      orgao: /SISPAR|PGFN|SIDA/.test(sistema) ? "PGFN" : "Receita Federal", sistema, numero,
      modalidade: limpar(conteudo.replace(/CNPJ:\s*[\d./-]+/, "")).slice(0, 160),
      emAtraso: !!emAtraso, parcelasEmAtraso: parcelas ? +parcelas[1] : 0, valorEmAtraso: vAtraso ? valorNum(vAtraso[1]) : 0, valorSuspenso: 0,
    }];
  }

  // ------------------------------------------------------------------ omissões / processos
  function lerOmissao(titulo, conteudo) {
    const decl = limpar(titulo.replace(/^Pend[êe]ncia\s*[-–]\s*Omiss[ãa]o de\s*/i, "").replace(/\*+$/, ""));
    const itens = [];
    const re = /\((Per[íi]odo de Apura[çc][ãa]o|Ano-Calend[áa]rio|Exerc[íi]cio|Compet[êe]ncia)\)\s*([\s\S]*?)(?=\(|\*|$)/gi;
    let m;
    while ((m = re.exec(conteudo))) {
      const periodos = limpar(m[2]);
      if (periodos) itens.push({ declaracao: decl, tipoPeriodo: limpar(m[1]), periodos });
    }
    if (!itens.length) {
      const resto = limpar(conteudo.replace(/\*.*$/, "").replace(/CNPJ:\s*[\d./-]+/, ""));
      if (resto) itens.push({ declaracao: decl, tipoPeriodo: "Período", periodos: resto });
    }
    return itens;
  }

  function lerProcessos(conteudo) {
    const itens = [];
    const re = new RegExp(`(${RE_PROCESSO.source})\\s+([A-ZÀ-Ú][A-ZÀ-Ú ]*?)\\s{2,}([\\s\\S]*?)(?=${RE_PROCESSO.source}|$)`, "g");
    let m;
    while ((m = re.exec(conteudo))) itens.push({ processo: m[1], situacao: limpar(m[2]), localizacao: limpar(m[3]) });
    return itens;
  }

  // ------------------------------------------------------------------ agrupamentos de apresentação
  const MESES = { "01": 1, "02": 2, "03": 3, "04": 4, "05": 5, "06": 6, "07": 7, "08": 8, "09": 9, "10": 10, "11": 11, "12": 12 };
  function chaveMes(pa) { const m = /^(\d{2})\/(\d{4})$/.exec(pa); return m && MESES[m[1]] ? +m[2] * 12 + MESES[m[1]] : null; }

  // "04/2026, 05/2026, 06/2026, 08/2026" → "04/2026 a 06/2026 e 08/2026"
  function resumirPeriodos(pas) {
    const meses = pas.map((p) => ({ p, k: chaveMes(p) }));
    if (meses.some((x) => x.k === null)) return pas.join(", ");
    meses.sort((a, b) => a.k - b.k);
    const blocos = [];
    for (const x of meses) {
      const b = blocos[blocos.length - 1];
      if (b && x.k === b.fimK + 1) { b.fim = x.p; b.fimK = x.k; } else blocos.push({ ini: x.p, fim: x.p, fimK: x.k });
    }
    const textos = blocos.map((b) => (b.ini === b.fim ? b.ini : `${b.ini} a ${b.fim}`));
    return textos.length > 1 ? textos.slice(0, -1).join(", ") + " e " + textos[textos.length - 1] : textos[0];
  }

  function agruparPorTributo(debitos) {
    const grupos = new Map();
    for (const d of debitos) {
      const chave = d.multaDeclaracao ? "MAED" : d.tributo;
      if (!grupos.has(chave)) grupos.set(chave, { tributo: d.multaDeclaracao ? "Multas por atraso de declaração (MAED)" : d.tributo, categoria: d.categoria, multa: d.multaDeclaracao, itens: [], total: 0 });
      const g = grupos.get(chave);
      g.itens.push(d);
      g.total += d.valor || 0;
    }
    for (const g of grupos.values()) {
      g.itens.sort((a, b) => (chaveMes(a.pa) ?? 0) - (chaveMes(b.pa) ?? 0));
      g.periodos = g.multa ? g.itens.map((d) => `${d.receita.replace(/^\d{4}-\d{2}\s*-\s*MAED\s*-?\s*/i, "")} (${d.pa})`).join(", ") : resumirPeriodos(g.itens.map((d) => d.pa));
    }
    return [...grupos.values()].sort((a, b) => b.total - a.total);
  }

  // ------------------------------------------------------------------ análise completa
  function analisarSitfis(textoOriginal, { referencia, semMaed = false } = {}) {
    const cab = extrairCabecalho(textoOriginal);
    const limpo = removerRuido(textoOriginal);
    const secoes = separarSecoes(limpo);

    const r = {
      ...cab,
      simples: extrairHistoricoOpcao(limpo, "Simples Nacional"),
      simei: extrairHistoricoOpcao(limpo, "SIMEI"),
      certidao: extrairCertidao(limpo),
      debitosAbertos: [],      // Pendência - Débito (SIEF)
      debitosSuspensos: [],    // Débito com Exigibilidade Suspensa (SIEF)
      inscricoesAbertas: [],   // Pendência - Inscrição (SIDA)
      inscricoesSuspensas: [], // Inscrição com Exigibilidade Suspensa (SIDA)
      parcelamentos: [],
      omissoes: [],
      processos: [],
      outrasPendencias: [],    // seções de pendência que este leitor ainda não conhece
      secoesReconhecidas: 0,
      pgfnSemPendencias: /N[ãa]o foram detectadas pend[êe]ncias\/exigibilidades suspensas para esse contribuinte nos controles da Procuradoria/i.test(limpo),
      rfbSemPendencias: /N[ãa]o foram detectadas pend[êe]ncias\/exigibilidades suspensas para esse contribuinte nos controles da Receita/i.test(limpo),
    };
    r.simplesResumo = resumoSimples(r.simples, referencia);
    r.simeiResumo = resumoSimples(r.simei, referencia);

    for (const { titulo, conteudo } of secoes) {
      const t = titulo;
      const pendencia = /^Pend[êe]ncia/i.test(t);
      if (/D[ée]bito \(SIEF\)/i.test(t) && pendencia) { r.debitosAbertos.push(...lerDebitosSief(conteudo, false)); r.secoesReconhecidas++; }
      else if (/D[ée]bito com Exigibilidade Suspensa/i.test(t)) { r.debitosSuspensos.push(...lerDebitosSief(conteudo, true)); r.secoesReconhecidas++; }
      else if (/Inscri[çc][ãa]o \(SIDA\)/i.test(t) && pendencia) { r.inscricoesAbertas.push(...lerInscricoes(conteudo)); r.secoesReconhecidas++; }
      else if (/Inscri[çc][ãa]o com Exigibilidade Suspensa/i.test(t)) {
        if (RE_INSCRICAO.test(conteudo)) r.inscricoesSuspensas.push(...lerInscricoes(conteudo));
        else { // Sistema DIVIDA (antigo): "Inscrição: 13.878.920-7 Situação: 000731 - NEGOCIADO NO SISPAR"
          const re = /Inscri[çc][ãa]o:\s*([\d.\-]+)\s*Situa[çc][ãa]o:\s*([\s\S]*?)(?=Inscri[çc][ãa]o:|$)/gi;
          let m; while ((m = re.exec(conteudo))) r.inscricoesSuspensas.push({ inscricao: m[1], receita: "Sistema DÍVIDA", tributo: "Sistema DÍVIDA", categoria: "demais", situacao: limpar(m[2]) });
        }
        r.secoesReconhecidas++;
      }
      else if (/Parcelamento/i.test(t) && /SIEFPAR/i.test(t)) { r.parcelamentos.push(...lerSiefpar(conteudo, pendencia)); r.secoesReconhecidas++; }
      else if (/Parcelamento/i.test(t) && /PARCSN|PARCMEI/i.test(t)) { r.parcelamentos.push(...lerParcsn(conteudo, pendencia)); r.secoesReconhecidas++; }
      else if (/Parcelamento/i.test(t) && /SISPAR/i.test(t)) { r.parcelamentos.push(...lerSispar(conteudo, pendencia)); r.secoesReconhecidas++; }
      else if (/Parcelamento/i.test(t)) { r.parcelamentos.push(...lerParcelamentoGenerico(t, conteudo, pendencia)); r.secoesReconhecidas++; }
      else if (/Omiss[ãa]o/i.test(t)) { r.omissoes.push(...lerOmissao(t, conteudo)); r.secoesReconhecidas++; }
      else if (/Processo/i.test(t)) {
        const ps = lerProcessos(conteudo).map((p) => ({ ...p, suspenso: !pendencia }));
        r.processos.push(...ps); r.secoesReconhecidas++;
      }
      else if (pendencia) r.outrasPendencias.push({ titulo: t, texto: limpar(conteudo.replace(/CNPJ:\s*[\d./-]+/, "")).slice(0, 400) });
    }

    // Multas por atraso na entrega de declaração (MAED): o escritório pode escolher não mostrar.
    // Ocultas, elas saem de tudo (lista, totais, pendências e situação) — só fica a contagem em r.maedOcultas.
    r.maedOcultas = [];
    if (semMaed) {
      r.maedOcultas = r.debitosAbertos.filter((d) => d.multaDeclaracao);
      r.debitosAbertos = r.debitosAbertos.filter((d) => !d.multaDeclaracao);
    }
    r.temMaed = r.maedOcultas.length > 0 || r.debitosAbertos.some((d) => d.multaDeclaracao);

    // Suspensos: separa "a vencer" (nem venceu ainda) do que é parcelado/judicial
    r.debitosSuspensos.forEach((d) => { d.suspensao = classificarSuspensao(d.situacao); });
    r.inscricoesAbertas.forEach((i) => { i.estado = descreverSituacaoInscricao(i.situacao); });
    r.inscricoesSuspensas.forEach((i) => { i.estado = descreverSituacaoInscricao(i.situacao); });

    // ---------- Vincula inscrições negociadas às contas SISPAR (por categoria: Simples / Previdenciário / Demais).
    // O relatório NÃO diz qual inscrição está em qual conta; quando há mais de uma conta da mesma
    // categoria, elas ficam juntas num mesmo grupo — com aviso, sem inventar o vínculo.
    const contasSispar = r.parcelamentos.filter((p) => p.sistema === "SISPAR");
    const negociadas = r.inscricoesSuspensas.filter((i) => i.estado.chave === "negociada");
    const gruposPgfn = new Map();
    for (const c of contasSispar) {
      const cat = c.categoria || "outros";
      if (!gruposPgfn.has(cat)) gruposPgfn.set(cat, { categoria: cat, contas: [], inscricoes: [] });
      gruposPgfn.get(cat).contas.push(c);
    }
    const semConta = [];
    for (const i of negociadas) {
      let g = gruposPgfn.get(i.categoria);
      if (!g && gruposPgfn.size === 1) g = [...gruposPgfn.values()][0];
      if (g) g.inscricoes.push(i); else semConta.push(i);
    }
    r.negociacoesPgfn = [...gruposPgfn.values()].map((g) => ({
      ...g,
      titulo: `${g.contas.some((c) => c.tipo === "Transação") ? "Transação" : "Parcelamento"} na PGFN — ${ROTULO_CATEGORIA[g.categoria] || "outros débitos"}`,
      vinculoIncerto: g.contas.length > 1 && g.inscricoes.length > 0,
      emAtraso: g.contas.some((c) => c.emAtraso),
    }));
    r.inscricoesNegociadasSemConta = semConta;

    // ---------- Débitos suspensos ligados a parcelamentos da Receita (mesma categoria)
    const parcelamentosRfb = r.parcelamentos.filter((p) => p.orgao === "Receita Federal");
    r.debitosSuspensos.forEach((d) => {
      if (d.suspensao.chave !== "parcelado") return;
      const alvo = parcelamentosRfb.find((p) => (p.categoria || (p.sistema === "SIEFPAR" ? "demais" : null)) === d.categoria) ||
        (parcelamentosRfb.length === 1 ? parcelamentosRfb[0] : null);
      if (alvo) (alvo.debitos = alvo.debitos || []).push(d), (d.vinculado = true);
    });

    // ---------- Totais (nunca mistura em aberto com parcelado)
    const soma = (xs) => xs.reduce((s, x) => s + (x.valor || 0), 0);
    const aVencer = r.debitosSuspensos.filter((d) => d.suspensao.chave === "a_vencer");
    const parcelamentosAtraso = r.parcelamentos.filter((p) => p.emAtraso);
    r.totais = {
      emAbertoRfb: soma(r.debitosAbertos),
      qtdDebitosAbertos: r.debitosAbertos.length,
      qtdInscricoesCobranca: r.inscricoesAbertas.length,
      qtdParcelamentos: r.parcelamentos.filter((p) => p.sistema !== "SISPAR").length + r.negociacoesPgfn.length,
      qtdParcelamentosAtraso: parcelamentosAtraso.length,
      valorParcelasAtraso: parcelamentosAtraso.reduce((s, p) => s + (p.valorEmAtraso || 0), 0),
      qtdOmissoes: r.omissoes.length,
      aVencer: soma(aVencer),
      qtdAVencer: aVencer.length,
      suspensoParcelado: r.parcelamentos.reduce((s, p) => s + (p.valorSuspenso || 0), 0) + soma(r.debitosSuspensos.filter((d) => d.suspensao.chave === "parcelado")),
    };
    r.gruposAbertos = agruparPorTributo(r.debitosAbertos);
    r.outrosSuspensos = r.debitosSuspensos.filter((d) => !d.vinculado && d.suspensao.chave !== "a_vencer");
    r.aVencer = aVencer;
    r.inscricoesSuspensasOutras = r.inscricoesSuspensas.filter((i) => i.estado.chave !== "negociada");

    // ---------- Veredito (o que o próprio relatório indica sobre a certidão)
    const qtdPend = r.debitosAbertos.length + r.inscricoesAbertas.length + parcelamentosAtraso.length + r.omissoes.length +
      r.processos.filter((p) => !p.suspenso).length + r.outrasPendencias.length;
    const temSuspensao = r.debitosSuspensos.some((d) => d.suspensao.chave !== "a_vencer") || r.inscricoesSuspensas.length ||
      r.parcelamentos.some((p) => !p.emAtraso) || r.processos.some((p) => p.suspenso);
    r.qtdPendencias = qtdPend;
    r.veredito = qtdPend
      ? { chave: "pendente", rotulo: "Com pendências", texto: "Enquanto essas pendências não forem regularizadas, a certidão sai Positiva (não sai CND nem Positiva com Efeitos de Negativa)." }
      : temSuspensao
        ? { chave: "suspensa", rotulo: "Regular com suspensões", texto: "Sem pendências. Os débitos que existem estão parcelados ou suspensos, então a certidão tende a sair Positiva com Efeitos de Negativa." }
        : { chave: "regular", rotulo: "Regular", texto: "Nenhuma pendência nem débito suspenso. A certidão tende a sair Negativa." };
    return r;
  }

  const api = { analisarSitfis, removerRuido, separarSecoes, resumirPeriodos, ROTULO_CATEGORIA };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.SITFIS = api;
})(typeof window !== "undefined" ? window : globalThis);
