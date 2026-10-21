export interface OrderRecord {
  id: string;
  name: string;
  createdAt: number;
  status: 'active' | 'archived';
}

export class OrderService {
  private cache = new Map<string, OrderRecord>();

  async findById(id: string): Promise<OrderRecord | null> {
    return this.cache.get(id) || null;
  }

  async list(limit: number): Promise<OrderRecord[]> {
    return Array.from(this.cache.values()).slice(0, limit);
  }

  async update(id: string, data: Partial<OrderRecord>): Promise<OrderRecord> {
    const current = this.cache.get(id) || { id, name: 'Default', createdAt: Date.now(), status: 'active' };
    const merged = { ...current, ...data };
    this.cache.set(id, merged);
    return merged;
  }
}
