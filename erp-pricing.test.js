import test from 'node:test';
import assert from 'node:assert/strict';
import { buildErpDispatchPlan } from './erp-pricing.js';

const order = { id: 42, price_list_id: 1 };
const customer = { erp_id: 'ERP-CLIENTE' };
const lists = [
  { id: 1, name: 'Padrão', erp_id: 'ERP-PADRAO' },
  { id: 2, name: 'Atacado', erp_id: 'ERP-ATACADO' },
];

test('uma lista gera um único envio com total e chave estável', () => {
  const groups = buildErpDispatchPlan(order, customer, [
    { productId: 3, sku: 'A', qty: 2, price: 10, subtotal: 20, priceListId: 1 },
    { productId: 4, sku: 'B', qty: 1, price: 5, subtotal: 5, priceListId: 1 },
  ], lists);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].priceListErpId, 'ERP-PADRAO');
  assert.equal(groups[0].dispatchKey, 'order-42-list-1');
  assert.equal(groups[0].total, 25);
  assert.equal(groups[0].items.length, 2);
});

test('listas por produto geram envios separados e preservam o preço salvo', () => {
  const groups = buildErpDispatchPlan(order, customer, [
    { productId: 3, sku: 'A', qty: 2, price: 10, subtotal: 20, priceListId: 1 },
    { productId: 4, sku: 'B', qty: 3, price: 4.5, subtotal: 13.5, priceListId: 2, priceListErpId: 'ERP-ATACADO-ORIGINAL' },
  ], lists);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(group => group.total), [20, 13.5]);
  assert.deepEqual(groups.map(group => group.priceListId), [1, 2]);
  assert.equal(groups[1].priceListErpId, 'ERP-ATACADO-ORIGINAL');
});

test('pedidos anteriores usam a lista do cabeçalho', () => {
  const groups = buildErpDispatchPlan(order, customer, [
    { name: 'Produto antigo', qty: 2, price: 8.25 },
  ], lists);
  assert.equal(groups[0].priceListId, 1);
  assert.equal(groups[0].total, 16.5);
});
