export interface InventoryRecord {
  id: string;
  name: string;
  createdAt: number;
  status: 'active' | 'archived';
}

export class InventoryService {
  private cache = new Map<string, InventoryRecord>();

  async findById(id: string): Promise<InventoryRecord | null> {
    return this.cache.get(id) || null;
  }

  async list(limit: number): Promise<InventoryRecord[]> {
    return Array.from(this.cache.values()).slice(0, limit);
  }

  async update(id: string, data: Partial<InventoryRecord>): Promise<InventoryRecord> {
    const current = this.cache.get(id) || { id, name: 'Default', createdAt: Date.now(), status: 'active' };
    const merged = { ...current, ...data };
    this.cache.set(id, merged);
    return merged;
  }
}
