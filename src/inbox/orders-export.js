import express from 'express';
import { equal } from './security.js';

export function createOrdersExportRouter({ readOrders, env = process.env }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    const token = env.INBOX_ORDERS_READ_TOKEN;
    if (!token || !/^[a-zA-Z0-9_-]{40,128}$/.test(token)) return res.sendStatus(404);
    if (!equal(req.headers.authorization || '', `Bearer ${token}`)) return res.sendStatus(401);
    next();
  });
  router.get('/', async (req, res) => {
    try {
      const orders = await readOrders();
      if (!Array.isArray(orders)) throw new Error('Invalid orders store');
      res.json({ source: 'zakaz-amvera', orders: orders.map(order => ({
        id: order.id, createdAt: order.createdAt, customer: order.customer, phone: order.phone,
        comment: order.comment, totalSum: order.totalSum, totalQuantity: order.totalQuantity,
        items: Array.isArray(order.items) ? order.items.map(item => ({ id: item.id, vendorCode: item.vendorCode, name: item.name, quantity: item.quantity, cartPrice: item.cartPrice, sum: item.sum })) : []
      })) });
    } catch { res.status(503).json({ error: 'Заказы временно недоступны' }); }
  });
  router.all('/', (req, res) => res.status(405).set('Allow', 'GET').json({ error: 'Только чтение' }));
  return router;
}
