import { Request, Response } from 'express';
import { PaymentService } from '../services/paymentService';

export class PaymentController {
  private service: PaymentService;

  constructor() {
    this.service = new PaymentService();
  }

  public async getPaymentById(req: Request, res: Response): Promise<void> {
    try {
      const id = req.params.id;
      const result = await this.service.findById(id);
      if (!result) {
        res.status(404).json({ error: 'Payment not found' });
        return;
      }
      res.status(200).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  public async listPayments(req: Request, res: Response): Promise<void> {
    const limit = parseInt(req.query.limit as string || '20', 10);
    const items = await this.service.list(limit);
    res.json({ total: items.length, items });
  }

  public async updatePayment(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const updated = await this.service.update(id, req.body);
    res.json(updated);
  }
}
