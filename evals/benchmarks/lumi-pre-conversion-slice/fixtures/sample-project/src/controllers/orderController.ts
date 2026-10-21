import { Request, Response } from 'express';
import { OrderService } from '../services/orderService';

export class OrderController {
  private service: OrderService;

  constructor() {
    this.service = new OrderService();
  }

  public async getOrderById(req: Request, res: Response): Promise<void> {
    try {
      const id = req.params.id;
      const result = await this.service.findById(id);
      if (!result) {
        res.status(404).json({ error: 'Order not found' });
        return;
      }
      res.status(200).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  public async listOrders(req: Request, res: Response): Promise<void> {
    const limit = parseInt(req.query.limit as string || '20', 10);
    const items = await this.service.list(limit);
    res.json({ total: items.length, items });
  }

  public async updateOrder(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const updated = await this.service.update(id, req.body);
    res.json(updated);
  }
}
