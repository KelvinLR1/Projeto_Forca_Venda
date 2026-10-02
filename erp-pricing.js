export function buildErpDispatchPlan(order, customer, items, priceLists) {
  const listsById = new Map(priceLists.map(list => [Number(list.id), list]));
  const fallbackListId = Number(order.price_list_id ?? items[0]?.priceListId);
  const defaultList = listsById.get(fallbackListId);
  if (!defaultList) throw new Error(`Lista padrão ${fallbackListId} não encontrada.`);

  const plannedItems = items.map(item => {
    const priceListId = Number(item.priceListId ?? fallbackListId);
    const list = listsById.get(priceListId);
    if (!list) throw new Error(`Lista de preços ${priceListId} não encontrada.`);
    const quantity = Number(item.qty ?? item.quantity);
    const unitPrice = Number(item.price ?? item.unitPrice);
    const subtotal = Number(item.subtotal ?? Math.round(quantity * unitPrice * 100) / 100);
    return {
      productId: item.productId,
      name: item.name,
      sku: item.sku,
      quantity,
      unitPrice,
      subtotal,
      priceListId,
      priceListName: item.priceListName || list.name,
      priceListErpId: item.priceListErpId || list.erp_id,
    };
  });

  return [{
    localOrderId: order.id,
    dispatchKey: `order-${order.id}`,
    customerErpId: customer.erp_id,
    priceListId: defaultList.id,
    priceListName: defaultList.name,
    priceListErpId: defaultList.erp_id,
    items: plannedItems,
    total: Math.round(plannedItems.reduce((sum, item) => sum + item.subtotal, 0) * 100) / 100,
  }];
}
