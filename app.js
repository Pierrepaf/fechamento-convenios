const CONVENIOS = ["AMIL","BRADESCO","PORTO_SEGURO","UNIMED","PARTICULAR"];
const CONVENIO_LABEL = {AMIL:"Amil", BRADESCO:"Bradesco", PORTO_SEGURO:"Porto Seguro", UNIMED:"Unimed", PARTICULAR:"Particular"};
const fmtBRL = v => (v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const cleanMoney = v => Math.abs(v) < 0.005 ? 0 : v; // avoids "-R$0,00" from floating-point noise on near-zero diffs
const pad2 = n => String(n).padStart(2,'0');
const monthKey = iso => iso ? iso.slice(0,7) : '';
const monthLabel = key => { if(!key) return ''; const [y,m]=key.split('-'); return new Date(Number(y),Number(m)-1,1).toLocaleDateString('pt-BR',{month:'short',year:'numeric'}); };
const todayISO = () => new Date().toISOString().slice(0,10);
const todayMonthKey = () => todayISO().slice(0,7);
function addMonths(mkey, n){ let [y,m]=mkey.split('-').map(Number); m+=n; while(m>12){m-=12;y++;} while(m<1){m+=12;y--;} return `${y}-${pad2(m)}`; }
function daysInMonth(y,m){ return new Date(y,m,0).getDate(); }
function blockNonNumeric(input){
  input.addEventListener('keydown', e=>{ if(['e','E','+','-'].includes(e.key)) e.preventDefault(); });
  input.addEventListener('paste', e=>{
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if(/[eE+\-]/.test(text)) e.preventDefault();
  });
}

// ---------------- Supabase wiring ----------------
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let state = {
  atendimentos: [],  // {id, data, medica, convenio, tipo_servico, procedimento, paciente, valor, protocolo_id, arquivado}
  protocolos: [],    // {id, numero, convenio, mes, valor_informado, recebido, data_recebida, valor_recebido}
  parametros: {},    // chave -> {atraso_meses, dia_pagamento}
  unimedCortes: {},  // mes -> dia_corte (last day of that month's 1st quinzena; payment days themselves are fixed: 15 and last day of month)
  repasseMariana: 0.30,
};

function numify(rows, fields){
  rows.forEach(r => fields.forEach(f => { if(r[f] !== null && r[f] !== undefined) r[f] = Number(r[f]); }));
  return rows;
}

async function sbSelect(table){
  const { data, error } = await supabaseClient.from(table).select('*');
  if(error) throw error;
  return data;
}
async function sbInsert(table, row){
  const { data, error } = await supabaseClient.from(table).insert(row).select().single();
  if(error) throw error;
  return data;
}
async function sbUpdate(table, idField, idValue, patch){
  const { error } = await supabaseClient.from(table).update(patch).eq(idField, idValue);
  if(error) throw error;
}
async function sbDelete(table, idField, idValue){
  const { error } = await supabaseClient.from(table).delete().eq(idField, idValue);
  if(error) throw error;
}

async function refreshAtendimentos(){
  state.atendimentos = numify(await sbSelect('atendimentos'), ['valor']);
  renderAll();
}
const ativos = () => state.atendimentos.filter(a=>!a.arquivado);
async function refreshProtocolosData(){
  state.protocolos = numify(await sbSelect('protocolos'), ['valor_informado','valor_recebido']);
  renderAll();
}
async function refreshParametros(){
  const rows = numify(await sbSelect('parametros'), []);
  const p = {};
  rows.forEach(r => { p[r.chave] = r; });
  state.parametros = p;
  renderAll();
}
async function refreshUnimedCortes(){
  const rows = await sbSelect('unimed_cortes');
  const p = {};
  rows.forEach(r => { p[r.mes] = Number(r.dia_corte); });
  state.unimedCortes = p;
  renderAll();
}
async function refreshConfig(){
  const rows = await sbSelect('config');
  if(rows[0]) state.repasseMariana = Number(rows[0].repasse_mariana);
  renderAll();
}

function corteDoMes(mesAt){
  // Cutoff day splitting that month's 1st quinzena from its 2nd. Varies month to month (Lenice sets it
  // in Parâmetros); defaults to 15 for any month not yet configured.
  const c = state.unimedCortes[mesAt];
  return c === undefined ? 15 : c;
}
function quinzenaOf(dataISO){
  const [y,m,d] = dataISO.split('-').map(Number);
  const corte = corteDoMes(`${y}-${pad2(m)}`);
  return d <= corte ? "1-15" : "16-30";
}
function computeDataPagamento(at){
  const key = at.convenio + "_" + at.tipo_servico;
  const param = state.parametros[key];
  if(!param) return null;
  const [y,m] = at.data.split('-').map(Number);
  if(param.atraso_meses === 0) return at.data;
  const targetKey = addMonths(`${y}-${pad2(m)}`, param.atraso_meses);
  const [ty,tm] = targetKey.split('-').map(Number);
  let dia;
  if(at.convenio === "UNIMED"){
    // Payment day is fixed, not configurable: 1st quinzena always pays on the 15th, 2nd quinzena
    // always pays on the last day of the payment month. Only the quinzena cutoff itself varies.
    dia = quinzenaOf(at.data) === "1-15" ? 15 : daysInMonth(ty,tm);
  } else {
    dia = param.dia_pagamento;
  }
  const finalDia = Math.min(dia, daysInMonth(ty,tm));
  return `${ty}-${pad2(tm)}-${pad2(finalDia)}`;
}
function withPagamento(at){ const dp = computeDataPagamento(at); return {...at, dataPagamento: dp, mesPagamento: monthKey(dp)}; }

async function init(){
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  try{
    await Promise.all([refreshAtendimentos(), refreshProtocolosData(), refreshParametros(), refreshUnimedCortes(), refreshConfig()]);
    statusDot.classList.remove('off');
    statusText.textContent = 'sincronizado';
  } catch(err){
    statusText.textContent = 'sem conexão de dados';
    console.error(err);
    return;
  }

  supabaseClient.channel('atendimentos-changes').on('postgres_changes', {event:'*', schema:'public', table:'atendimentos'}, refreshAtendimentos).subscribe();
  supabaseClient.channel('protocolos-changes').on('postgres_changes', {event:'*', schema:'public', table:'protocolos'}, refreshProtocolosData).subscribe();
  supabaseClient.channel('parametros-changes').on('postgres_changes', {event:'*', schema:'public', table:'parametros'}, refreshParametros).subscribe();
  supabaseClient.channel('unimed-cortes-changes').on('postgres_changes', {event:'*', schema:'public', table:'unimed_cortes'}, refreshUnimedCortes).subscribe();
  supabaseClient.channel('config-changes').on('postgres_changes', {event:'*', schema:'public', table:'config'}, refreshConfig).subscribe();
}

// ---------------- Nav ----------------
document.getElementById('nav').addEventListener('click', e=>{
  const btn = e.target.closest('button[data-view]');
  if(!btn) return;
  document.querySelectorAll('#nav button').forEach(b=>b.classList.toggle('active', b===btn));
  document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active', v.id === 'view-'+btn.dataset.view));
});

// ---------------- Lançamentos ----------------
const PROCEDIMENTOS_EXAME = ["TONO","RETINO","MR","TOPO","PAQUI","BIO","GONIO","US","T. SCHIRMER"];
let editingId = null;

function refreshProcedimentoOptions(){
  const tipo = document.getElementById('fTipo').value;
  const sel = document.getElementById('fProcedimento');
  const prev = sel.value;
  document.getElementById('fProcedimentoWrap').hidden = (tipo === 'CONSULTA');
  if(tipo === 'CONSULTA'){
    sel.innerHTML = '';
    sel.disabled = true;
  } else if(tipo === 'EXAME'){
    sel.disabled = false;
    sel.innerHTML = PROCEDIMENTOS_EXAME.map(p=>`<option value="${p}">${p}</option>`).join('') + `<option value="__outro">Outro…</option>`;
    if(PROCEDIMENTOS_EXAME.includes(prev) || prev==='__outro') sel.value = prev;
  } else {
    sel.innerHTML = `<option value="">Selecione o tipo primeiro</option>`;
    sel.disabled = true;
  }
  toggleProcedimentoOutro();
}
function toggleProcedimentoOutro(){
  const isOutro = document.getElementById('fProcedimento').value === '__outro';
  document.getElementById('fProcedimentoOutroWrap').hidden = !isOutro;
}
document.getElementById('fTipo').addEventListener('change', refreshProcedimentoOptions);
document.getElementById('fProcedimento').addEventListener('change', toggleProcedimentoOutro);

function resetForm(){
  editingId = null;
  document.getElementById('formTitulo').textContent = 'Novo lançamento';
  document.getElementById('btnSalvarLancamento').textContent = 'Salvar';
  document.getElementById('fData').value = todayISO();
  document.getElementById('fMedica').value = '';
  document.getElementById('fConvenio').value = '';
  document.getElementById('fTipo').value = '';
  refreshProcedimentoOptions();
  document.getElementById('fProcedimentoOutro').value = '';
  document.getElementById('fPaciente').value = '';
  document.getElementById('fValor').value = '';
}

document.getElementById('btnNovoLancamento').addEventListener('click', ()=>{
  resetForm();
  document.getElementById('btnSalvarNovoLancamento').hidden = false;
  document.getElementById('formNovoLancamento').hidden = false;
  document.getElementById('formNovoLancamento').scrollIntoView({behavior:'smooth', block:'start'});
});
document.getElementById('btnCancelarLancamento').addEventListener('click', ()=>{
  document.getElementById('formNovoLancamento').hidden = true;
  editingId = null;
});
document.getElementById('btnFecharLancamento').addEventListener('click', ()=>{
  document.getElementById('formNovoLancamento').hidden = true;
  editingId = null;
});

function abrirEdicao(id){
  const a = state.atendimentos.find(x=>x.id===id);
  if(!a) return;
  editingId = id;
  document.getElementById('formTitulo').textContent = 'Editar lançamento';
  document.getElementById('btnSalvarLancamento').textContent = 'Salvar edição';
  document.getElementById('btnSalvarNovoLancamento').hidden = true;
  document.getElementById('fData').value = a.data;
  document.getElementById('fMedica').value = a.medica;
  document.getElementById('fConvenio').value = a.convenio;
  document.getElementById('fTipo').value = a.tipo_servico;
  refreshProcedimentoOptions();
  if(a.tipo_servico === 'EXAME'){
    if(PROCEDIMENTOS_EXAME.includes(a.procedimento)){
      document.getElementById('fProcedimento').value = a.procedimento;
    } else {
      document.getElementById('fProcedimento').value = '__outro';
      document.getElementById('fProcedimentoOutro').value = a.procedimento;
    }
  }
  toggleProcedimentoOutro();
  document.getElementById('fPaciente').value = a.paciente || '';
  document.getElementById('fValor').value = a.valor;
  document.getElementById('formNovoLancamento').hidden = false;
  document.getElementById('formNovoLancamento').scrollIntoView({behavior:'smooth', block:'start'});
}

async function salvarLancamento(btn, keepOpenForNext){
  const data = document.getElementById('fData').value;
  const medica = document.getElementById('fMedica').value;
  const convenio = document.getElementById('fConvenio').value;
  const tipo = document.getElementById('fTipo').value;
  const valor = parseFloat(document.getElementById('fValor').value);
  const paciente = document.getElementById('fPaciente').value.trim();
  if(!data || !medica || !convenio || !tipo || isNaN(valor) || !paciente){ alert('Preencha todos os campos: data, médica, convênio, tipo, paciente e valor.'); return; }
  let procedimento = tipo === 'CONSULTA' ? '' : document.getElementById('fProcedimento').value;
  if(procedimento === '__outro') procedimento = document.getElementById('fProcedimentoOutro').value.trim() || 'EXAME';
  const doc = { data, medica, convenio, tipo_servico: tipo, procedimento, paciente, valor };
  const originalText = btn.textContent;
  btn.disabled = true; btn.textContent = 'Salvando…';
  try{
    if(editingId){
      await sbUpdate('atendimentos', 'id', editingId, doc);
    } else {
      await sbInsert('atendimentos', doc);
    }
    if(keepOpenForNext){
      editingId = null;
      document.getElementById('fTipo').value = '';
      refreshProcedimentoOptions();
      document.getElementById('fProcedimentoOutro').value = '';
      document.getElementById('fValor').value = '';
      document.getElementById('fTipo').focus();
    } else {
      document.getElementById('formNovoLancamento').hidden = true;
      editingId = null;
    }
  } catch(err){
    alert('Não foi possível salvar (' + (err && err.message || 'erro') + '). Tente novamente.');
  } finally {
    btn.disabled = false; btn.textContent = originalText;
  }
}
document.getElementById('btnSalvarLancamento').addEventListener('click', ()=>{
  salvarLancamento(document.getElementById('btnSalvarLancamento'), false);
});
document.getElementById('btnSalvarNovoLancamento').addEventListener('click', ()=>{
  salvarLancamento(document.getElementById('btnSalvarNovoLancamento'), true);
});
refreshProcedimentoOptions();
blockNonNumeric(document.getElementById('fValor'));
blockNonNumeric(document.getElementById('protValorInformado'));

['filData','filMedica','filConvenio','filArquivados'].forEach(id=>document.getElementById(id).addEventListener('change', renderLancamentos));
document.getElementById('filPaciente').addEventListener('input', renderLancamentos);
document.getElementById('btnLimparFiltros').addEventListener('click', ()=>{
  document.getElementById('filData').value = '';
  document.getElementById('filMedica').value = '';
  document.getElementById('filConvenio').value = '';
  document.getElementById('filPaciente').value = '';
  document.getElementById('filArquivados').checked = false;
  renderLancamentos();
});

function populateMonthOptions(select, keepFirst){
  const months = Array.from(new Set(state.atendimentos.map(a=>monthKey(a.data)))).sort();
  const current = select.value;
  select.innerHTML = '';
  if(keepFirst) select.appendChild(new Option(keepFirst, ''));
  months.forEach(m=> select.appendChild(new Option(monthLabel(m), m)));
  if(months.includes(current)) select.value = current;
}

function renderLancamentos(){
  const data = document.getElementById('filData').value;
  const medica = document.getElementById('filMedica').value;
  const convenio = document.getElementById('filConvenio').value;
  const busca = document.getElementById('filPaciente').value.trim().toLowerCase();
  const mostrarArquivados = document.getElementById('filArquivados').checked;

  let rows = state.atendimentos.filter(a=>
    (mostrarArquivados || !a.arquivado) &&
    (!data || a.data===data) &&
    (!medica || a.medica===medica) && (!convenio || a.convenio===convenio) &&
    (!busca || (a.paciente||'').toLowerCase().includes(busca))
  ).sort((a,b)=> b.data.localeCompare(a.data) || (b.created_at||'').localeCompare(a.created_at||''));

  document.getElementById('filCount').textContent = rows.length + ' itens';
  const tbody = document.getElementById('tblLancamentos');
  if(rows.length===0){ tbody.innerHTML = `<tr><td colspan="9" class="empty">Nenhum lançamento encontrado.</td></tr>`; return; }
  tbody.innerHTML = rows.map(a=>{
    const proto = a.protocolo_id ? (state.protocolos.find(p=>p.id===a.protocolo_id)?.numero || '—') : '—';
    return `<tr style="${a.arquivado ? 'opacity:.5' : ''}">
      <td>${a.data.split('-').reverse().join('/')}</td>
      <td>${a.medica==='LENICE'?'Lenice':'Mariana'}</td>
      <td>${CONVENIO_LABEL[a.convenio]||a.convenio}</td>
      <td>${a.paciente||''}</td>
      <td>${a.tipo_servico==='CONSULTA'?'Consulta':'Exame'}</td>
      <td>${a.procedimento||''}</td>
      <td class="right num">${fmtBRL(a.valor)}</td>
      <td>${a.arquivado ? '<span class="pill neutral">arquivado</span>' : (a.protocolo_id ? `<span class="pill neutral">${proto}</span>` : '<span class="pill amber">sem protocolo</span>')}</td>
      <td style="white-space:nowrap">
        ${a.arquivado
          ? `<button class="icon-btn" data-unarch="${a.id}" title="Desarquivar">↺</button>`
          : `<button class="icon-btn" data-edit="${a.id}" title="Editar">✎</button>
             <button class="icon-btn" data-arch="${a.id}" title="Arquivar">✕</button>`
        }
      </td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('[data-arch]').forEach(btn=> btn.addEventListener('click', async ()=>{
    if(!confirm('Arquivar este lançamento? Ele deixa de contar nos relatórios e some da lista, mas fica salvo (você pode desarquivar depois marcando "Mostrar arquivados").')) return;
    try{ await sbUpdate('atendimentos', 'id', btn.dataset.arch, {arquivado:true}); }
    catch(err){ alert('Não foi possível arquivar (' + (err && err.message || 'erro') + '). Tente novamente.'); }
  }));
  tbody.querySelectorAll('[data-unarch]').forEach(btn=> btn.addEventListener('click', async ()=>{
    try{ await sbUpdate('atendimentos', 'id', btn.dataset.unarch, {arquivado:false}); }
    catch(err){ alert('Não foi possível desarquivar (' + (err && err.message || 'erro') + '). Tente novamente.'); }
  }));
  tbody.querySelectorAll('[data-edit]').forEach(btn=> btn.addEventListener('click', ()=> abrirEdicao(btn.dataset.edit)));
}

// ---------------- Protocolos ----------------
document.getElementById('protFiltroConvenio').addEventListener('change', renderProtocolos);
document.getElementById('protFiltroMes').addEventListener('change', renderProtocolos);
document.getElementById('protFiltroArquivados').addEventListener('change', renderProtocolos);

function protoAggregates(protoId){
  const items = ativos().filter(a=>a.protocolo_id===protoId);
  const lenice = items.filter(a=>a.medica==='LENICE').reduce((s,a)=>s+a.valor,0);
  const mariana = items.filter(a=>a.medica==='MARIANA').reduce((s,a)=>s+a.valor,0);
  let pagamento = null;
  for(const it of items){ const d = computeDataPagamento(it); if(d && (!pagamento || d>pagamento)) pagamento = d; }
  return { items, somado: lenice+mariana, lenice, mariana, dataPagamento: pagamento };
}

let expandedProtocolos = new Set();
let vinculacao = null; // {protocoloId, convenio, mes}
let editingProtocolo = null; // id of the protocolo whose número/valor informado is being edited

function pendentesDoGrupo(convenio, mes){
  return ativos().filter(a=>a.convenio===convenio && monthKey(a.data)===mes && !a.protocolo_id)
    .sort((a,b)=> a.data.localeCompare(b.data));
}

function checklistRowHtml(a){
  return `
      <label class="check-row">
        <input type="checkbox" value="${a.id}" data-tipo="${a.tipo_servico}" class="protoChk">
        <span class="who ${a.medica}">${a.medica==='LENICE'?'Lenice':'Mariana'}</span>
        <span class="desc">${a.data.split('-').reverse().join('/')} · ${a.tipo_servico==='CONSULTA'?'Consulta':a.procedimento||'Exame'} · ${a.paciente||''}</span>
        <span class="val num">${fmtBRL(a.valor)}</span>
      </label>`;
}

document.getElementById('vincularQuinzena').addEventListener('change', renderCheckListVinculacao);

function renderCheckListVinculacao(){
  const { convenio, mes } = vinculacao;
  let pendentes = pendentesDoGrupo(convenio, mes);
  const list = document.getElementById('protCheckList');
  const quinzenaWrap = document.getElementById('vincularQuinzenaWrap');

  let corte, ultimoDia;
  if(convenio === 'UNIMED'){
    quinzenaWrap.hidden = false;
    const [y,m] = mes.split('-').map(Number);
    corte = corteDoMes(mes);
    ultimoDia = daysInMonth(y,m);
    const sel = document.getElementById('vincularQuinzena');
    const current = sel.value;
    sel.innerHTML = `<option value="">Todas</option><option value="1-15">Dia 1–${corte}</option><option value="16-30">Dia ${corte+1}–${ultimoDia}</option>`;
    if(current === '1-15' || current === '16-30') sel.value = current;
    const quinzenaFiltro = sel.value;
    if(quinzenaFiltro) pendentes = pendentes.filter(a=> quinzenaOf(a.data) === quinzenaFiltro);
  } else {
    quinzenaWrap.hidden = true;
  }

  if(pendentes.length===0){
    list.innerHTML = `<div class="empty">Nada pendente — todos os itens já têm protocolo.</div>`;
  } else if(convenio === 'UNIMED'){
    const primeira = pendentes.filter(a=> quinzenaOf(a.data)==='1-15');
    const segunda = pendentes.filter(a=> quinzenaOf(a.data)==='16-30');
    list.innerHTML =
      (primeira.length ? `<div class="filter-label" style="margin:4px 0">Dia 1–${corte} (${primeira.length})</div>${primeira.map(checklistRowHtml).join('')}` : '') +
      (segunda.length ? `<div class="filter-label" style="margin:8px 0 4px">Dia ${corte+1}–${ultimoDia} (${segunda.length})</div>${segunda.map(checklistRowHtml).join('')}` : '');
  } else {
    list.innerHTML = pendentes.map(checklistRowHtml).join('');
  }
  list.querySelectorAll('.protoChk').forEach(c=> c.addEventListener('change', updateVincularBtn));
  updateVincularBtn();
}

function updateVincularBtn(){
  const n = document.querySelectorAll('.protoChk:checked').length;
  const btn = document.getElementById('btnVincularSelecionados');
  btn.disabled = n===0;
  btn.textContent = n>0 ? `Vincular ${n} selecionado(s)` : 'Vincular selecionados';
}

function setChecksByTipo(tipo, val){
  document.querySelectorAll(`.protoChk[data-tipo="${tipo}"]`).forEach(c=> c.checked = val);
  updateVincularBtn();
}
document.getElementById('btnSelTodasConsultas').addEventListener('click', ()=> setChecksByTipo('CONSULTA', true));
document.getElementById('btnSelTodosExames').addEventListener('click', ()=> setChecksByTipo('EXAME', true));
document.getElementById('btnSelNenhum').addEventListener('click', ()=>{
  document.querySelectorAll('.protoChk').forEach(c=>c.checked=false);
  updateVincularBtn();
});

function openVincular(protocoloId, convenio, mes){
  vinculacao = { protocoloId, convenio, mes };
  document.getElementById('vincularQuinzena').value = '';
  const p = state.protocolos.find(x=>x.id===protocoloId);
  document.getElementById('vincularInfo').innerHTML = p ? `
    <div><div class="k">Convênio</div><div class="v">${CONVENIO_LABEL[convenio]||convenio}</div></div>
    <div><div class="k">Mês</div><div class="v">${monthLabel(mes)}</div></div>
    <div><div class="k">Protocolo</div><div class="v">${p.numero}</div></div>
    <div><div class="k">Valor informado</div><div class="v">${p.valor_informado ? fmtBRL(p.valor_informado) : '—'}</div></div>
  ` : '';
  document.getElementById('formNovoProtocolo').hidden = true;
  document.getElementById('formVincularItens').hidden = false;
  renderCheckListVinculacao();
  document.getElementById('formVincularItens').scrollIntoView({behavior:'smooth', block:'start'});
}

document.getElementById('btnNovoProtocolo').addEventListener('click', ()=>{
  document.getElementById('protNovoConvenio').value = document.getElementById('protFiltroConvenio').value;
  populateMonthOptions(document.getElementById('protNovoMes'), 'Selecione…');
  document.getElementById('protNovoMes').value = document.getElementById('protFiltroMes').value;
  document.getElementById('protNumero').value = '';
  document.getElementById('protValorInformado').value = '';
  document.getElementById('formVincularItens').hidden = true;
  vinculacao = null;
  document.getElementById('formNovoProtocolo').hidden = false;
  document.getElementById('formNovoProtocolo').scrollIntoView({behavior:'smooth', block:'start'});
});
document.getElementById('btnCancelarNovoProtocolo').addEventListener('click', ()=>{
  document.getElementById('formNovoProtocolo').hidden = true;
});
document.getElementById('btnFecharNovoProtocolo').addEventListener('click', ()=>{
  document.getElementById('formNovoProtocolo').hidden = true;
});
document.getElementById('btnFecharVincular').addEventListener('click', ()=>{
  document.getElementById('formVincularItens').hidden = true;
  vinculacao = null;
});

document.getElementById('btnCriarProtocoloShell').addEventListener('click', async ()=>{
  const convenio = document.getElementById('protNovoConvenio').value;
  const mes = document.getElementById('protNovoMes').value;
  const numero = document.getElementById('protNumero').value.trim();
  const valorInformado = parseFloat(document.getElementById('protValorInformado').value);
  if(!convenio || !mes || !numero || isNaN(valorInformado)){ alert('Preencham convênio, mês, número do protocolo e valor informado pelo convênio — todos são obrigatórios.'); return; }
  const btn = document.getElementById('btnCriarProtocoloShell');
  const originalText = btn.textContent;
  btn.disabled = true; btn.textContent = 'Salvando…';
  try{
    const novo = await sbInsert('protocolos', {
      numero, convenio, mes, valor_informado: valorInformado,
      recebido:false, data_recebida:null, valor_recebido:null
    });
    novo.valor_informado = Number(novo.valor_informado);
    state.protocolos.push(novo); // realtime refresh hasn't round-tripped yet; add it locally so it's found right away
    openVincular(novo.id, convenio, mes);
  } catch(err){
    alert('Não foi possível criar o protocolo (' + (err && err.message || 'erro') + '). Tente novamente.');
  } finally {
    btn.disabled = false; btn.textContent = originalText;
  }
});

document.getElementById('btnVincularSelecionados').addEventListener('click', async ()=>{
  const ids = Array.from(document.querySelectorAll('.protoChk:checked')).map(c=>c.value);
  if(ids.length===0 || !vinculacao) return;
  const btn = document.getElementById('btnVincularSelecionados');
  const originalText = btn.textContent;
  btn.disabled = true; btn.textContent = 'Vinculando…';
  try{
    for(const id of ids) await sbUpdate('atendimentos', 'id', id, {protocolo_id: vinculacao.protocoloId});
    document.getElementById('formVincularItens').hidden = true;
    vinculacao = null;
  } catch(err){
    alert('Não foi possível vincular (' + (err && err.message || 'erro') + '). Tente novamente.');
  } finally {
    btn.disabled = false; btn.textContent = originalText;
  }
});

function renderProtocolos(){
  populateMonthOptions(document.getElementById('protFiltroMes'), 'Todos');

  const convenioFiltro = document.getElementById('protFiltroConvenio').value;
  const mesFiltro = document.getElementById('protFiltroMes').value;
  const mostrarArquivados = document.getElementById('protFiltroArquivados').checked;

  const protocolosFiltrados = state.protocolos
    .filter(p=> (mostrarArquivados || !p.arquivado) && (!convenioFiltro || p.convenio===convenioFiltro) && (!mesFiltro || p.mes===mesFiltro))
    .sort((a,b)=> b.mes.localeCompare(a.mes) || a.convenio.localeCompare(b.convenio) || a.numero.localeCompare(b.numero));

  const semProtocolo = ativos().filter(a=>
    a.convenio !== 'PARTICULAR' && !a.protocolo_id &&
    (!convenioFiltro || a.convenio===convenioFiltro) && (!mesFiltro || monthKey(a.data)===mesFiltro)
  );
  const semProtocoloValor = semProtocolo.reduce((s,a)=>s+a.valor,0);
  document.getElementById('protSemProtocoloBanner').innerHTML = semProtocolo.length===0
    ? `<div class="banner sage">✓ Nenhum lançamento sem protocolo</div>`
    : `<div class="banner amber">${semProtocolo.length} lançamento(s) sem protocolo — ${fmtBRL(semProtocoloValor)}</div>`;

  if(vinculacao) renderCheckListVinculacao();

  const listEl = document.getElementById('protList');
  if(protocolosFiltrados.length===0){
    listEl.innerHTML = `<div class="empty">Nenhum protocolo encontrado.</div>`;
  } else {
    listEl.innerHTML = protocolosFiltrados.map(p=>{
      const agg = protoAggregates(p.id);
      const diffAgrupamento = cleanMoney(agg.somado - (p.valor_informado||0));
      const diffAgrupamentoOk = Math.abs(diffAgrupamento) < 0.005 || !p.valor_informado;
      const diffPagamento = p.recebido ? cleanMoney((p.valor_informado||0) - (p.valor_recebido||0)) : null;
      const diffPagamentoOk = diffPagamento===null || Math.abs(diffPagamento) < 0.005;
      const expanded = expandedProtocolos.has(p.id);
      const itemsSorted = [...agg.items].sort((a,b)=> a.data.localeCompare(b.data));
      const isEditing = editingProtocolo === p.id;
      return `<div class="proto-card" style="${p.arquivado?'opacity:.55':''}">
        <div class="top">
          <div style="display:flex; flex-direction:column; align-items:flex-start; gap:6px">
            <span class="num">Protocolo ${p.numero}</span>
            <div style="display:flex; gap:6px; flex-wrap:wrap">
              <span class="pill neutral">${CONVENIO_LABEL[p.convenio]||p.convenio} · ${monthLabel(p.mes)}</span>
              ${p.arquivado ? '<span class="pill neutral">arquivado</span>' : ''}
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:8px">
            ${p.arquivado ? '' : `<button class="icon-btn" data-editp="${p.id}" title="Editar número/valor informado">✎</button>`}
            ${p.recebido ? '<span class="pill sage">recebido</span>' : '<span class="pill amber">aguardando</span>'}
          </div>
        </div>
        ${isEditing ? `
        <div class="toolbar" style="margin-top:10px; align-items:flex-end">
          <div class="field"><label>Número do protocolo</label><input type="text" id="editNumero_${p.id}" value="${p.numero}"></div>
          <div class="field"><label>Valor informado</label><input type="number" step="0.01" class="protoValorInf" id="editValorInf_${p.id}" value="${p.valor_informado ?? ''}"></div>
          <button class="btn" data-saveeditp="${p.id}">Salvar</button>
          <button class="btn secondary" data-canceleditp="${p.id}">Cancelar</button>
        </div>` : ''}
        <div class="proto-grid">
          <div><div class="k">Lançamentos</div><div class="v">${fmtBRL(agg.somado)}</div></div>
          <div><div class="k">Protocolo</div><div class="v">${p.valor_informado ? fmtBRL(p.valor_informado) : '—'}</div></div>
          <div><div class="k">Diferença de agrupamento</div><div class="v ${diffAgrupamentoOk?'diff-ok':'diff-bad'}">${p.valor_informado ? fmtBRL(diffAgrupamento) : '—'}</div></div>
          <div><div class="k">Recebido</div><div class="v">${p.recebido ? fmtBRL(p.valor_recebido||0) : '—'}</div></div>
          <div><div class="k">Diferença de pagamento</div><div class="v ${diffPagamentoOk?'diff-ok':'diff-bad'}">${diffPagamento===null ? '—' : fmtBRL(diffPagamento)}</div></div>
          <div><div class="k">Pagamento esperado</div><div class="v">${agg.dataPagamento ? agg.dataPagamento.split('-').reverse().join('/') : '—'}</div></div>
        </div>
        <div class="toolbar" style="margin-top:10px; margin-bottom:0">
          <button class="btn secondary" data-toggleitems="${p.id}">${expanded ? 'Ocultar' : 'Ver'} lançamentos (${agg.items.length})</button>
          ${p.arquivado ? '' : `<button class="btn secondary" data-vincular="${p.id}" data-convenio="${p.convenio}" data-mes="${p.mes}">Vincular lançamentos</button>`}
        </div>
        <div class="table-wrap" ${expanded?'':'hidden'} data-itemswrap="${p.id}">
          <table>
            <thead><tr><th>Data</th><th>Médica</th><th>Paciente</th><th>Tipo</th><th>Procedimento</th><th class="right">Valor</th></tr></thead>
            <tbody>${itemsSorted.map(it=>`<tr>
              <td>${it.data.split('-').reverse().join('/')}</td>
              <td>${it.medica==='LENICE'?'Lenice':'Mariana'}</td>
              <td>${it.paciente||''}</td>
              <td>${it.tipo_servico==='CONSULTA'?'Consulta':'Exame'}</td>
              <td>${it.procedimento||''}</td>
              <td class="right num">${fmtBRL(it.valor)}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
        ${p.arquivado ? `
        <div class="proto-recv">
          <button class="icon-btn" data-unarchp="${p.id}" title="Desarquivar">↺ desarquivar</button>
        </div>` : `
        <div class="proto-recv">
          <div class="field"><label>Recebido?</label>
            <select data-recv="${p.id}"><option value="nao" ${!p.recebido?'selected':''}>Não</option><option value="sim" ${p.recebido?'selected':''}>Sim</option></select>
          </div>
          <div class="field"><label>Data recebida</label><input type="date" data-recdata="${p.id}" value="${p.data_recebida||''}"></div>
          <div class="field"><label>Valor recebido</label><input type="number" step="0.01" data-recval="${p.id}" value="${p.valor_recebido ?? ''}"></div>
          <button class="btn secondary" data-savep="${p.id}">Salvar</button>
          <button class="icon-btn" data-delp="${p.id}" title="Arquivar protocolo (desmarca os itens)">✕ arquivar</button>
        </div>`}
      </div>`;
    }).join('');

    listEl.querySelectorAll('[data-toggleitems]').forEach(btn=> btn.addEventListener('click', ()=>{
      const id = btn.dataset.toggleitems;
      if(expandedProtocolos.has(id)) expandedProtocolos.delete(id); else expandedProtocolos.add(id);
      renderProtocolos();
    }));
    listEl.querySelectorAll('[data-vincular]').forEach(btn=> btn.addEventListener('click', ()=> openVincular(btn.dataset.vincular, btn.dataset.convenio, btn.dataset.mes)));
    listEl.querySelectorAll('[data-unarchp]').forEach(btn=> btn.addEventListener('click', async ()=>{
      try{ await sbUpdate('protocolos', 'id', btn.dataset.unarchp, {arquivado:false}); }
      catch(err){ alert('Não foi possível desarquivar (' + (err && err.message || 'erro') + '). Tente novamente.'); }
    }));
    listEl.querySelectorAll('.protoValorInf').forEach(inp=> blockNonNumeric(inp));
    listEl.querySelectorAll('[data-editp]').forEach(btn=> btn.addEventListener('click', ()=>{
      editingProtocolo = btn.dataset.editp;
      renderProtocolos();
    }));
    listEl.querySelectorAll('[data-canceleditp]').forEach(btn=> btn.addEventListener('click', ()=>{
      editingProtocolo = null;
      renderProtocolos();
    }));
    listEl.querySelectorAll('[data-saveeditp]').forEach(btn=> btn.addEventListener('click', async ()=>{
      const id = btn.dataset.saveeditp;
      const numero = document.getElementById(`editNumero_${id}`).value.trim();
      const valorInformado = parseFloat(document.getElementById(`editValorInf_${id}`).value);
      if(!numero || isNaN(valorInformado)){ alert('Número do protocolo e valor informado são obrigatórios.'); return; }
      const originalText = btn.textContent;
      btn.disabled = true; btn.textContent = 'Salvando…';
      try{
        await sbUpdate('protocolos', 'id', id, { numero, valor_informado: valorInformado });
        editingProtocolo = null;
      } catch(err){
        alert('Não foi possível salvar (' + (err && err.message || 'erro') + '). Tente novamente.');
      } finally {
        btn.disabled = false; btn.textContent = originalText;
      }
    }));
    listEl.querySelectorAll('[data-savep]').forEach(btn=> btn.addEventListener('click', async ()=>{
      const id = btn.dataset.savep;
      const recebido = document.querySelector(`[data-recv="${id}"]`).value === 'sim';
      const dataRecebida = document.querySelector(`[data-recdata="${id}"]`).value;
      const valorRecebido = parseFloat(document.querySelector(`[data-recval="${id}"]`).value);
      const originalText = btn.textContent;
      btn.disabled = true; btn.textContent = 'Salvando…';
      try{
        await sbUpdate('protocolos', 'id', id, {
          recebido, data_recebida: dataRecebida||null, valor_recebido: isNaN(valorRecebido)?null:valorRecebido
        });
      } catch(err){
        alert('Não foi possível salvar (' + (err && err.message || 'erro') + '). Tente novamente.');
      } finally {
        btn.disabled = false; btn.textContent = originalText;
      }
    }));
    listEl.querySelectorAll('[data-delp]').forEach(btn=> btn.addEventListener('click', async ()=>{
      const id = btn.dataset.delp;
      if(!confirm('Arquivar este protocolo? Os lançamentos ligados a ele voltam a ficar sem protocolo, e o protocolo some da lista, mas fica salvo (você pode desarquivar depois marcando "Mostrar arquivados").')) return;
      try{
        const items = state.atendimentos.filter(a=>a.protocolo_id===id);
        for(const it of items) await sbUpdate('atendimentos', 'id', it.id, {protocolo_id: null});
        await sbUpdate('protocolos', 'id', id, {arquivado:true});
      } catch(err){
        alert('Não foi possível arquivar (' + (err && err.message || 'erro') + '). Tente novamente.');
      }
    }));
  }
}

// ---------------- Relatório ----------------
const N_MONTHS = 8;
function projectionRows(filterFn){
  const start = todayMonthKey();
  const months = Array.from({length:N_MONTHS}, (_,i)=>addMonths(start,i));
  const withPag = ativos().filter(filterFn).map(withPagamento).filter(a=>a.mesPagamento);
  return months.map(mkey=>{
    const row = {mes:mkey};
    CONVENIOS.forEach(c=> row[c] = withPag.filter(a=>a.mesPagamento===mkey && a.convenio===c).reduce((s,a)=>s+a.valor,0));
    row.total = CONVENIOS.reduce((s,c)=>s+row[c],0);
    return row;
  });
}

function renderMonthTable(el, rows, factor){
  const f = factor || 1;
  let html = `<table><thead><tr><th>Mês</th>${CONVENIOS.map(c=>`<th class="right">${CONVENIO_LABEL[c]}</th>`).join('')}<th class="right">Total</th></tr></thead><tbody>`;
  const totals = {}; CONVENIOS.forEach(c=>totals[c]=0); let grand=0;
  rows.forEach(r=>{
    html += `<tr><td>${monthLabel(r.mes)}</td>${CONVENIOS.map(c=>{totals[c]+=r[c]*f; return `<td class="right num">${fmtBRL(r[c]*f)}</td>`}).join('')}<td class="right num" style="font-weight:600">${fmtBRL(r.total*f)}</td></tr>`;
    grand += r.total*f;
  });
  html += `<tr style="font-weight:600"><td>Total</td>${CONVENIOS.map(c=>`<td class="right num">${fmtBRL(totals[c])}</td>`).join('')}<td class="right num">${fmtBRL(grand)}</td></tr>`;
  html += '</tbody></table>';
  el.innerHTML = html;
}

function renderDetalheTable(el, rows){
  let html = `<table><thead><tr><th>Mês</th>${CONVENIOS.map(c=>`<th class="right">${CONVENIO_LABEL[c]} - Cons.</th><th class="right">${CONVENIO_LABEL[c]} - Exame</th>`).join('')}<th class="right">Total</th></tr></thead><tbody>`;
  rows.forEach(r=>{
    let total=0;
    const cells = CONVENIOS.map(c=>{ total+=r[c].cons+r[c].exame; return `<td class="right num">${fmtBRL(r[c].cons)}</td><td class="right num">${fmtBRL(r[c].exame)}</td>`; }).join('');
    html += `<tr><td>${monthLabel(r.mes)}</td>${cells}<td class="right num" style="font-weight:600">${fmtBRL(total)}</td></tr>`;
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

function computeSemProtocolo(){
  const hoje = todayMonthKey();
  const grupos = {};
  ativos().forEach(a=>{
    if(a.convenio === 'PARTICULAR' || a.protocolo_id) return;
    const mk = monthKey(a.data);
    if(mk >= hoje) return; // mes ainda em andamento - nao e alarme
    const key = a.convenio + '|' + mk;
    if(!grupos[key]) grupos[key] = {convenio:a.convenio, mes:mk, count:0, valor:0};
    grupos[key].count++;
    grupos[key].valor += a.valor;
  });
  return Object.values(grupos).sort((a,b)=> a.mes.localeCompare(b.mes) || a.convenio.localeCompare(b.convenio));
}

function irParaProtocolo(convenio, mes){
  document.querySelectorAll('#nav button').forEach(b=>b.classList.toggle('active', b.dataset.view==='protocolos'));
  document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active', v.id==='view-protocolos'));
  document.getElementById('protFiltroConvenio').value = convenio;
  renderProtocolos();
  document.getElementById('protFiltroMes').value = mes;
  renderProtocolos();
}

function renderRelatorio(){
  document.getElementById('repassePct').textContent = Math.round(state.repasseMariana*100) + '%';

  const geral = projectionRows(()=>true);
  renderMonthTable(document.getElementById('tblGeral'), geral);
  const lenice = projectionRows(a=>a.medica==='LENICE');
  renderMonthTable(document.getElementById('tblLenice'), lenice);
  const marianaBruto = projectionRows(a=>a.medica==='MARIANA');
  renderMonthTable(document.getElementById('tblMarianaBruto'), marianaBruto);
  renderMonthTable(document.getElementById('tblMarianaLiquido'), marianaBruto, 1-state.repasseMariana);

  const semProtocolo = computeSemProtocolo();
  const semProtocoloTotal = semProtocolo.reduce((s,g)=>s+g.valor,0);
  document.getElementById('tituloSemProtocolo').textContent =
    `Trabalho ainda não enviado ao convênio${semProtocolo.length ? ' — ' + fmtBRL(semProtocoloTotal) : ''}`;
  const tblSem = document.getElementById('tblSemProtocolo');
  tblSem.innerHTML = semProtocolo.length===0
    ? `<tr><td colspan="5" class="empty">Nada esquecido — tudo que já passou do mês já está em algum protocolo.</td></tr>`
    : semProtocolo.map(g=>`<tr>
        <td>${CONVENIO_LABEL[g.convenio]}</td><td>${monthLabel(g.mes)}</td>
        <td class="right num">${g.count}</td><td class="right num">${fmtBRL(g.valor)}</td>
        <td><button class="btn secondary" data-irproto="${g.convenio}|${g.mes}">Ver</button></td>
      </tr>`).join('');
  tblSem.querySelectorAll('[data-irproto]').forEach(btn=> btn.addEventListener('click', ()=>{
    const [convenio, mes] = btn.dataset.irproto.split('|');
    irParaProtocolo(convenio, mes);
  }));

  const start = todayMonthKey();
  const months = Array.from({length:N_MONTHS}, (_,i)=>addMonths(start,i));
  const withPag = ativos().map(withPagamento).filter(a=>a.mesPagamento);
  const detalhe = months.map(mkey=>{
    const row = {mes:mkey};
    CONVENIOS.forEach(c=>{
      const items = withPag.filter(a=>a.mesPagamento===mkey && a.convenio===c);
      row[c] = { cons: items.filter(a=>a.tipo_servico==='CONSULTA').reduce((s,a)=>s+a.valor,0),
                 exame: items.filter(a=>a.tipo_servico==='EXAME').reduce((s,a)=>s+a.valor,0) };
    });
    return row;
  });
  renderDetalheTable(document.getElementById('tblDetalhe'), detalhe);

  const kpis = document.getElementById('kpis');
  const mesAtual = geral[0], mesProximo = geral[1];
  const pct = Math.round(state.repasseMariana*100);
  const marianaThis = marianaBruto[0].total, marianaNext = marianaBruto[1].total;
  const repasseThis = marianaThis * state.repasseMariana;
  const repasseNext = marianaNext * state.repasseMariana;
  const repasse2m = repasseThis + repasseNext;
  const marianaLiquidoThis = marianaThis - repasseThis;
  const marianaLiquidoNext = marianaNext - repasseNext;
  const leniceThis = lenice[0].total, leniceNext = lenice[1].total;
  const leniceTotal = leniceThis + leniceNext + repasse2m;
  const marianaTotal = marianaLiquidoThis + marianaLiquidoNext;
  const kpiCard = (nome, total, rows) => `
    <div class="card">
      <div class="card-pad">
        <h2>${nome}</h2>
        <div class="value num" style="font-size:30px; font-weight:700; line-height:1.15; margin-top:6px">${fmtBRL(total)}</div>
        <div style="display:flex; flex-direction:column; gap:7px; margin-top:14px; padding-top:12px; border-top:1px solid var(--border)">
          ${rows.map(r=>`<div style="display:flex; justify-content:space-between; gap:12px">
            <span style="color:var(--ink-soft)">${r.label}</span><span class="num ${r.cls||''}">${r.val}</span>
          </div>`).join('')}
        </div>
      </div>
    </div>`;
  kpis.innerHTML =
    kpiCard('Lenice', leniceTotal, [
      {label: monthLabel(mesAtual.mes), val: fmtBRL(leniceThis)},
      {label: monthLabel(mesProximo.mes), val: fmtBRL(leniceNext)},
      {label: `${pct}% de Mariana`, val: fmtBRL(repasse2m)},
    ]) +
    kpiCard('Mariana', marianaTotal, [
      {label: monthLabel(mesAtual.mes), val: fmtBRL(marianaLiquidoThis)},
      {label: monthLabel(mesProximo.mes), val: fmtBRL(marianaLiquidoNext)},
      {label: `Repasse (${pct}%)`, val: '-'+fmtBRL(repasse2m), cls: 'diff-bad'},
    ]);

  const pend = state.protocolos.filter(p=>!p.recebido && !p.arquivado).map(p=>({...p, ...protoAggregates(p.id)}))
    .sort((a,b)=> (a.dataPagamento||'9999').localeCompare(b.dataPagamento||'9999'));
  document.getElementById('tituloPendentes').textContent = `Enviado ao convênio, aguardando cair no banco${pend.length ? ' (' + pend.length + ')' : ''}`;
  const tbody = document.getElementById('tblPendentes');
  tbody.innerHTML = pend.length===0 ? `<tr><td colspan="6" class="empty">Nenhum protocolo pendente.</td></tr>` :
    pend.map(p=>`<tr>
      <td>${CONVENIO_LABEL[p.convenio]}</td><td>${monthLabel(p.mes)}</td><td>${p.numero}</td>
      <td class="right num">${fmtBRL(p.valor_informado || p.somado)}</td>
      <td>${p.dataPagamento ? p.dataPagamento.split('-').reverse().join('/') : '—'}</td>
      <td><span class="pill amber">aguardando</span></td>
    </tr>`).join('');

  const comDiferenca = state.protocolos.filter(p=>!p.arquivado).map(p=>{
    const agg = protoAggregates(p.id);
    const diffAgrupamento = cleanMoney(agg.somado - (p.valor_informado||0));
    const diffPagamento = p.recebido ? cleanMoney((p.valor_informado||0) - (p.valor_recebido||0)) : null;
    return {...p, diffAgrupamento, diffPagamento};
  }).filter(p=> Math.abs(p.diffAgrupamento)>=0.005 || (p.diffPagamento!==null && Math.abs(p.diffPagamento)>=0.005))
    .sort((a,b)=> b.mes.localeCompare(a.mes));
  document.getElementById('tituloDiferencas').textContent = `Valores que não batem${comDiferenca.length ? ' (' + comDiferenca.length + ')' : ''}`;
  const tblDif = document.getElementById('tblDiferencas');
  tblDif.innerHTML = comDiferenca.length===0 ? `<tr><td colspan="6" class="empty">Nenhuma diferença encontrada.</td></tr>` :
    comDiferenca.map(p=>`<tr>
      <td>${CONVENIO_LABEL[p.convenio]}</td><td>${monthLabel(p.mes)}</td><td>${p.numero}</td>
      <td class="right num ${Math.abs(p.diffAgrupamento)<0.005?'diff-ok':'diff-bad'}">${fmtBRL(p.diffAgrupamento)}</td>
      <td class="right num ${p.diffPagamento===null||Math.abs(p.diffPagamento)<0.005?'diff-ok':'diff-bad'}">${p.diffPagamento===null?'—':fmtBRL(p.diffPagamento)}</td>
      <td><button class="btn secondary" data-irproto="${p.convenio}|${p.mes}">Ver</button></td>
    </tr>`).join('');
  tblDif.querySelectorAll('[data-irproto]').forEach(btn=> btn.addEventListener('click', ()=>{
    const [convenio, mes] = btn.dataset.irproto.split('|');
    irParaProtocolo(convenio, mes);
  }));
}

// ---------------- Parâmetros ----------------
const TIPO_LABEL = {CONSULTA:'Consulta', EXAME:'Exame'};
function renderParametros(){
  document.getElementById('fRepasse').value = Math.round(state.repasseMariana*100);

  const tbody = document.getElementById('tblParametros');
  const keys = Object.keys(state.parametros).sort();
  tbody.innerHTML = keys.map(key=>{
    const p = state.parametros[key];
    const isUnimed = p.convenio === 'UNIMED';
    return `<tr>
      <td>${CONVENIO_LABEL[p.convenio]||p.convenio}</td><td>${TIPO_LABEL[p.tipo_servico]||p.tipo_servico}</td>
      <td><input type="number" style="width:70px" data-atr="${key}" value="${p.atraso_meses ?? 0}"></td>
      <td>${isUnimed ? '<span class="pill neutral">fixo: dia 15 / último dia do mês</span>' : `<input type="number" style="width:70px" data-dia="${key}" value="${p.dia_pagamento ?? ''}">`}</td>
      <td><button class="btn secondary" data-savepar="${key}">Salvar</button></td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('[data-savepar]').forEach(btn=> btn.addEventListener('click', async ()=>{
    const key = btn.dataset.savepar;
    const atrasoMeses = parseInt(document.querySelector(`[data-atr="${key}"]`).value, 10) || 0;
    const diaInput = document.querySelector(`[data-dia="${key}"]`);
    const diaPagamento = diaInput ? (parseInt(diaInput.value,10) || null) : null;
    try{
      await sbUpdate('parametros', 'chave', key, {atraso_meses: atrasoMeses, dia_pagamento: diaPagamento});
      btn.textContent = 'Salvo ✓'; setTimeout(()=>btn.textContent='Salvar', 1200);
    } catch(err){
      alert('Não foi possível salvar (' + (err && err.message || 'erro') + '). Tente novamente.');
    }
  }));

  const utbody = document.getElementById('tblUnimedPrazos');
  const umeses = Object.keys(state.unimedCortes).sort();
  utbody.innerHTML = umeses.map(mes=>{
    const corte = state.unimedCortes[mes];
    const [y,m] = mes.split('-').map(Number);
    const ultimoDia = daysInMonth(y,m);
    return `<tr>
      <td>${monthLabel(mes)}</td>
      <td><input type="number" style="width:70px" min="1" max="${ultimoDia}" data-corte="${mes}" value="${corte}"></td>
      <td class="hint" style="margin:0">1ª: dia 1–${corte} (paga dia 15) · 2ª: dia ${corte+1}–${ultimoDia} (paga no último dia do mês)</td>
      <td><button class="btn secondary" data-saveu="${mes}">Salvar</button></td>
    </tr>`;
  }).join('');
  utbody.querySelectorAll('[data-saveu]').forEach(btn=> btn.addEventListener('click', async ()=>{
    const mes = btn.dataset.saveu;
    const corte = parseInt(document.querySelector(`[data-corte="${mes}"]`).value,10);
    if(!corte || corte<1 || corte>31) return;
    try{
      await sbUpdate('unimed_cortes', 'mes', mes, {dia_corte: corte});
      btn.textContent = 'Salvo ✓'; setTimeout(()=>btn.textContent='Salvar', 1200);
    } catch(err){
      alert('Não foi possível salvar (' + (err && err.message || 'erro') + '). Tente novamente.');
    }
  }));
}
document.getElementById('btnSalvarRepasse').addEventListener('click', async ()=>{
  const pct = parseFloat(document.getElementById('fRepasse').value);
  if(isNaN(pct)) return;
  try{
    await sbUpdate('config', 'id', 1, {repasse_mariana: pct/100});
  } catch(err){
    alert('Não foi possível salvar (' + (err && err.message || 'erro') + '). Tente novamente.');
  }
});

function renderAll(){
  renderLancamentos();
  renderProtocolos();
  renderRelatorio();
  renderParametros();
}

init();
