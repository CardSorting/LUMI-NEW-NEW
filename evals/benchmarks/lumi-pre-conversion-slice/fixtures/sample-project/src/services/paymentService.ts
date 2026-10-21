export interface PaymentRecord {
  id: string;
  name: string;
  createdAt: number;
  status: 'active' | 'archived';
}

export class PaymentService {
  private cache = new Map<string, PaymentRecord>();

  async findById(id: string): Promise<PaymentRecord | null> {
    return this.cache.get(id) || null;
  }

  async list(limit: number): Promise<PaymentRecord[]> {
    return Array.from(this.cache.values()).slice(0, limit);
  }

  async update(id: string, data: Partial<PaymentRecord>): Promise<PaymentRecord> {
    const current = this.cache.get(id) || { id, name: 'Default', createdAt: Date.now(), status: 'active' };
    const merged = { ...current, ...data };
    this.cache.set(id, merged);
    return merged;
  }
}
