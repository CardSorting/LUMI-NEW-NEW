export interface HealthRecord {
  id: string;
  name: string;
  createdAt: number;
  status: 'active' | 'archived';
}

export class HealthService {
  private cache = new Map<string, HealthRecord>();

  async findById(id: string): Promise<HealthRecord | null> {
    return this.cache.get(id) || null;
  }

  async list(limit: number): Promise<HealthRecord[]> {
    return Array.from(this.cache.values()).slice(0, limit);
  }

  async update(id: string, data: Partial<HealthRecord>): Promise<HealthRecord> {
    const current = this.cache.get(id) || { id, name: 'Default', createdAt: Date.now(), status: 'active' };
    const merged = { ...current, ...data };
    this.cache.set(id, merged);
    return merged;
  }
}
