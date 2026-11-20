// Confere o motor de cálculo extraído de index.html.
// Com taxas 0, 1 placa e 1 filamento, o resultado novo só difere do antigo
// pela reserva de falha (agora sobre base + fixos) e pelo acabamento padrão (5 min).
import fs from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
const cut = script.indexOf("$('loginForm')");
if (cut < 0) throw new Error('não achei o início da UI para isolar o motor');

const context = {
  console, Math, Number, String, Error, Object, JSON, parseInt, parseFloat,
  isNaN, isFinite, NaN, Infinity, Map, Set, RegExp, Array, Date,
};
context.window = context;
context.globalThis = context;
vm.createContext(context);
vm.runInContext(script.slice(0, cut) + '\nglobalThis.__api={calcPeca,precoDeVenda,parseGcode,agregarPlacas,rotuloReserva,taxasDe};', context);
const {calcPeca, precoDeVenda, parseGcode, agregarPlacas, rotuloReserva} = context.__api;

const fails = [];
function assert(cond, msg) { if (!cond) fails.push(msg); }
function near(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }
const br = (v) => v.toLocaleString('pt-BR', {style: 'currency', currency: 'BRL'});
const n4 = (v) => v.toLocaleString('pt-BR', {minimumFractionDigits: 4, maximumFractionDigits: 4});

const P = {
  PLA: 130, kwh: 1.173, potencia_w: 180, impressora_rs: 4000, upgrades_rs: 0,
  vida_util_h: 5000, fixos_mensais_rs: 250, horas_produtivas_mes: 176,
  taxa_falha: 0.1, mao_obra_rs_h: 31.25,
};
const base = {
  material: 'PLA', weight: '32.44', length: '', waste: '0', diameter: '1.75', density: '1.24',
  printHours: '3', printMinutes: '20', quantity: '1', plateHandlingMinutes: '0', plates: 1,
};
const zeros = {embalagem_rs: 0, taxa_fixa_venda_rs: 0, taxa_marketplace_pct: 0, taxa_cartao_pct: 0, imposto_pct: 0};

function calcOld(inp, params) {
  const g = Number(inp.weight) > 0
    ? Number(inp.weight)
    : Number(inp.length) * Math.PI * (Number(inp.diameter) / 2) ** 2 / 1000 * Number(inp.density);
  const gMesa = g + Number(inp.waste);
  const hMesa = Number(inp.printHours) + Number(inp.printMinutes) / 60;
  const q = Number(inp.quantity);
  const gramas = gMesa / q;
  const horas = hMesa / q;
  const min_mao_obra = (Number(inp.plateHandlingMinutes) + Number(inp.finishMinutesPerPiece) * q) / q;
  const custo_material = gramas / 1000 * params[inp.material];
  const custo_energia = params.potencia_w / 1000 * horas * params.kwh;
  const custo_desgaste = (params.impressora_rs + params.upgrades_rs) / params.vida_util_h * horas;
  const custo_fixos = params.fixos_mensais_rs / params.horas_produtivas_mes * horas;
  const b = custo_material + custo_energia + custo_desgaste;
  const reserva_falha = b / (1 - params.taxa_falha) - b;
  const custo_sem_mo = b + custo_fixos + reserva_falha;
  const custo_mao_obra = params.mao_obra_rs_h * min_mao_obra / 60;
  const custo_com_mo = custo_sem_mo + custo_mao_obra;
  return {gramas, horas, min_mao_obra, custo_material, custo_energia, custo_desgaste, custo_fixos, base: b, reserva_falha, custo_sem_mo, custo_mao_obra, custo_com_mo, preco: custo_com_mo * 1.3};
}

const old = calcOld({...base, finishMinutesPerPiece: '0.5'}, P);
const sameFinish = calcPeca({...base, finishMinutesPerPiece: '0.5'}, P);
const novo = calcPeca({...base, finishMinutesPerPiece: '5'}, P);
const precoSame = precoDeVenda(sameFinish.custo_com_mo, 30, zeros);
const precoNovo = precoDeVenda(novo.custo_com_mo, 30, zeros);

for (const k of ['gramas', 'horas', 'custo_material', 'custo_energia', 'custo_desgaste', 'custo_fixos', 'base']) {
  assert(near(sameFinish[k], old[k]), `com acabamento 0,5 min, ${k} mudou: ${sameFinish[k]} vs ${old[k]}`);
  assert(near(novo[k], old[k]), `com acabamento 5 min, ${k} mudou sem dever: ${novo[k]} vs ${old[k]}`);
}
const deltaReserva = old.custo_fixos * (1 / (1 - P.taxa_falha) - 1);
assert(near(sameFinish.reserva_falha - old.reserva_falha, deltaReserva), 'a reserva nova não é a antiga mais o fator sobre os fixos');
assert(near(sameFinish.custo_sem_mo - old.custo_sem_mo, deltaReserva), 'o custo sem mão de obra não acompanha só a reserva');
assert(near(sameFinish.custo_com_mo - old.custo_com_mo, deltaReserva), 'com o mesmo acabamento, o custo com mão de obra deveria mudar só pela reserva');
assert(near(sameFinish.custo_sem_mo, (sameFinish.base + sameFinish.custo_fixos) / (1 - P.taxa_falha)), 'custo sem mão de obra não é (base+fixos)/(1-f)');
assert(precoSame.preco === sameFinish.custo_com_mo * 1.3, 'taxas zero não reproduzem custo × (1+markup)');
assert(precoNovo.preco === novo.custo_com_mo * 1.3, 'taxas zero não reproduzem o preço novo');
assert(near(precoNovo.margem, 30 / 130 * 100), 'margem efetiva com taxas zero não é markup/(100+markup)');
assert(near(novo.custo_mao_obra - old.custo_mao_obra, P.mao_obra_rs_h * 4.5 / 60), 'a mão de obra não subiu só os 4,5 min de acabamento');
assert(rotuloReserva(0.1) === 'Reserva de falha (10% de falha → +11,1%)', 'rótulo da reserva: ' + rotuloReserva(0.1));

let emptyThrew = false;
try { calcPeca({...base, weight: '', length: ''}, P); } catch (e) { emptyThrew = /peso|comprimento/.test(e.message); }
assert(emptyThrew, 'peso e comprimento vazios deveriam falhar');

const porComprimento = calcPeca({...base, weight: '', length: '1000', finishMinutesPerPiece: '5'}, P);
const gEsp = 1000 * Math.PI * (1.75 / 2) ** 2 / 1000 * 1.24;
assert(porComprimento.fonte_peso === 'comprimento', 'fonte deveria ser comprimento');
assert(near(porComprimento.gramas_filamento, gEsp), 'gramas do comprimento divergem');

const duas = calcPeca({...base, weight: '64.88', printHours: '6', printMinutes: '40', plates: 2, quantity: '1', finishMinutesPerPiece: '5'}, P);
assert(near(duas.gramas, 32.44) && near(duas.horas, 10 / 3) && duas.pecas === 2, 'duas placas iguais não dividem por peça');
const lote = calcPeca({...base, weight: '40', plates: 2, quantity: '2', plateHandlingMinutes: '10', finishMinutesPerPiece: '5'}, P);
assert(near(lote.gramas, 10) && lote.pecas === 4, 'quantidade × placas não fecha');
assert(near(lote.min_mao_obra, 10 / 2 + 5), 'mão de obra por peça não reparte a preparação por mesa');

const comTaxa = precoDeVenda(100, 30, {embalagem_rs: 2, taxa_fixa_venda_rs: 3, taxa_marketplace_pct: 10, taxa_cartao_pct: 5, imposto_pct: 5});
assert(near(comTaxa.antes, 130) && near(comTaxa.preco, 135 / 0.8) && near(comTaxa.lucro, 30), 'fórmula das taxas divergiu');
assert(near(comTaxa.margem, 30 / comTaxa.preco * 100), 'margem efetiva não é lucro/preço');
let pctThrew = false;
try { precoDeVenda(100, 30, {...zeros, imposto_pct: 100}); } catch (e) { pctThrew = /100%/.test(e.message); }
assert(pctThrew, 'taxa percentual de 100% deveria falhar');

const g1 = [
  '; filament used [g] = 20.00, 12.44',
  '; total filament used [g] = 32.44',
  '; total filament used for wipe tower [g] = 1.20',
  '; filament_type = PLA;PETG',
  '; estimated printing time (normal mode) = 2h 0m 0s',
].join('\n');
const g2 = [
  '; filament used [g] = 10.00',
  '; total filament used [g] = 10.00',
  '; flush filament used [g] = 1.50',
  '; filament_type = PLA',
  '; estimated printing time (normal mode) = 1h 20m 0s',
].join('\n');
const p1 = parseGcode(g1); p1.nome = 'plate_1.gcode'; p1.selecionada = true;
const p2 = parseGcode(g2); p2.nome = 'plate_2.gcode'; p2.selecionada = true;
assert(near(p1.totalGramas, 32.44) && near(p1.purgaGramas, 1.2) && p1.purgaSomada === false, 'torre de purga foi somada por cima do total');
assert(p1.usadas.length === 2 && near(p1.usadas[0].gramas, 20) && near(p1.usadas[1].gramas, 12.44), 'gramas por filamento não foram lidas');
assert(near(p2.totalGramas, 11.5) && p2.purgaSomada === true, 'flush fora do total não entrou no peso');
const agg = agregarPlacas([p1, p2]);
assert(agg.totalPlacas === 2 && near(agg.totalGramas, 43.94) && near(agg.segundos, 2 * 3600 + (1 * 3600 + 20 * 60)), 'soma das placas divergiu');
assert(agg.usadas.length === 2 && near(agg.usadas[0].gramas, 31.5) && near(agg.usadas[1].gramas, 12.44), 'soma por filamento entre placas divergiu');
p2.selecionada = false;
const so1 = agregarPlacas([p1, p2]);
assert(near(so1.totalGramas, 32.44) && so1.totalPlacas === 2 && near(so1.segundos, 7200), 'desmarcar placa não tira o peso dela da soma');

assert(!/zip\.file\(placas\[0\]\)/.test(html), 'o .3mf ainda lê só a primeira placa');
assert(/for\s*\(const nome of nomes\)/.test(html), 'o .3mf não percorre todas as placas');
assert(/id="finishMinutesPerPiece"[^>]*value="5"/.test(html), 'acabamento padrão não é 5 min');
assert(/id="length"[^>]*value=""/.test(html), 'comprimento ainda tem valor padrão');
assert(/id="embalagemRs"/.test(html) && /id="taxaMarketplace"/.test(html) && /id="impostoPct"/.test(html), 'faltam campos de taxa');

const linhas = [
  ['Material', old.custo_material],
  ['Energia', old.custo_energia],
  ['Desgaste', old.custo_desgaste],
  ['Fixos', old.custo_fixos],
  ['Base (material+energia+desgaste)', old.base],
  ['Reserva de falha', old.reserva_falha, sameFinish.reserva_falha, novo.reserva_falha],
  ['Custo sem mão de obra', old.custo_sem_mo, sameFinish.custo_sem_mo, novo.custo_sem_mo],
  ['Mão de obra', old.custo_mao_obra, sameFinish.custo_mao_obra, novo.custo_mao_obra],
  ['Custo com mão de obra', old.custo_com_mo, sameFinish.custo_com_mo, novo.custo_com_mo],
  ['Preço (markup 30%, taxas 0)', old.preco, precoSame.preco, precoNovo.preco],
];
console.log('Exemplo: 32,44 g · 3h20 · PLA R$ 130/kg · 180 W · R$ 1,173/kWh · impressora R$ 4000 / 5000 h (upgrades R$ 0) · fixos R$ 250/176 h · f=0,1 · mão de obra R$ 31,25/h · 1 peça · 1 placa · taxas 0');
console.log('Colunas: ANTES (reserva só na base, acabamento 0,5 min) | SÓ RESERVA NOVA (acabamento 0,5 min) | DEPOIS (reserva nova + acabamento 5 min)');
for (const [nome, a, b, c] of linhas) {
  const cols = [a, b ?? a, c ?? a].map((v) => n4(v).padStart(12)).join('  ');
  console.log(nome.padEnd(42) + cols);
}
console.log('Preço antes (centavos): ' + br(Math.round(old.preco * 100) / 100));
console.log('Preço só com a reserva nova (centavos): ' + br(Math.round(precoSame.preco * 100) / 100));
console.log('Preço depois (centavos): ' + br(Math.round(precoNovo.preco * 100) / 100));
console.log('Rótulo: ' + rotuloReserva(0.1));
console.log('Margem efetiva depois: ' + precoNovo.margem.toFixed(4) + '%');

if (fails.length) {
  console.error('\nFALHAS (' + fails.length + '):');
  for (const f of fails) console.error(' - ' + f);
  process.exit(1);
}
console.log('\nOK');
