export interface ProductRecord {
  id: string;
  name: string;
  createdAt: number;
  status: 'active' | 'archived';
}

export class ProductService {
  private cache = new Map<string, ProductRecord>();

  async findById(id: string): Promise<ProductRecord | null> {
    return this.cache.get(id) || null;
  }

  async list(limit: number): Promise<ProductRecord[]> {
    return Array.from(this.cache.values()).slice(0, limit);
  }

  async update(id: string, data: Partial<ProductRecord>): Promise<ProductRecord> {
    const current = this.cache.get(id) || { id, name: 'Default', createdAt: Date.now(), status: 'active' };
    const merged = { ...current, ...data };
    this.cache.set(id, merged);
    return merged;
  }
}
