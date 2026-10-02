export function buildErpDispatchPlan(order, customer, items, priceLists) {
  const listsById = new Map(priceLists.map(list => [Number(list.id), list]));
  const grouped = new Map();

  for (const item of items) {
    const priceListId = Number(item.priceListId ?? order.price_list_id);
    const list = listsById.get(priceListId);
    if (!list) throw new Error(`Lista de preços ${priceListId} não encontrada.`);
    if (!grouped.has(priceListId)) grouped.set(priceListId, []);
    const quantity = Number(item.qty ?? item.quantity);
    const unitPrice = Number(item.price ?? item.unitPrice);
    const subtotal = Number(item.subtotal ?? Math.round(quantity * unitPrice * 100) / 100);
    grouped.get(priceListId).push({
      productId: item.productId,
      name: item.name,
      sku: item.sku,
      quantity,
      unitPrice,
      subtotal,
      priceListErpId: item.priceListErpId || list.erp_id,
    });
  }

  return [...grouped].map(([priceListId, groupItems]) => {
    const list = listsById.get(priceListId);
    return {
      localOrderId: order.id,
      dispatchKey: `order-${order.id}-list-${priceListId}`,
      customerErpId: customer.erp_id,
      priceListId,
      priceListName: list.name,
      priceListErpId: groupItems[0].priceListErpId,
      items: groupItems,
      total: Math.round(groupItems.reduce((sum, item) => sum + item.subtotal, 0) * 100) / 100,
    };
  });
}
