import test from 'node:test';
import assert from 'node:assert/strict';
import { generateVisitRouteDates } from './visit-route-schedule.js';

test('rota avulsa gera apenas a data selecionada',()=>{
  assert.deepEqual(generateVisitRouteDates({frequency:'once',visit_date:'2026-09-30'}),['2026-09-30']);
});

test('recorrência semanal aceita mais de um dia e respeita o intervalo',()=>{
  const dates=generateVisitRouteDates({frequency:'weekly',visit_date:'2026-09-30',end_date:'2026-10-12',weekdays_json:'[1,3]'});
  assert.deepEqual(dates,['2026-09-30','2026-10-05','2026-10-07','2026-10-12']);
});

test('recorrência mensal agenda primeira e terceira segunda-feira',()=>{
  const dates=generateVisitRouteDates({frequency:'monthly',visit_date:'2026-09-01',end_date:'2026-10-31',weekdays_json:'[1]',weeks_json:'[1,3]'});
  assert.deepEqual(dates,['2026-09-07','2026-09-21','2026-10-05','2026-10-19']);
});

test('recorrência mensal ignora a quinta ocorrência quando o mês não a possui',()=>{
  const dates=generateVisitRouteDates({frequency:'monthly',visit_date:'2026-02-01',end_date:'2026-02-28',weekdays_json:'[1]',weeks_json:'[5]'});
  assert.deepEqual(dates,[]);
});
