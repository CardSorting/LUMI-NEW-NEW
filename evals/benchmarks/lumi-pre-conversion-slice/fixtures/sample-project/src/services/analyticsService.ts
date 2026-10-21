export interface AnalyticsRecord {
  id: string;
  name: string;
  createdAt: number;
  status: 'active' | 'archived';
}

export class AnalyticsService {
  private cache = new Map<string, AnalyticsRecord>();

  async findById(id: string): Promise<AnalyticsRecord | null> {
    return this.cache.get(id) || null;
  }

  async list(limit: number): Promise<AnalyticsRecord[]> {
    return Array.from(this.cache.values()).slice(0, limit);
  }

  async update(id: string, data: Partial<AnalyticsRecord>): Promise<AnalyticsRecord> {
    const current = this.cache.get(id) || { id, name: 'Default', createdAt: Date.now(), status: 'active' };
    const merged = { ...current, ...data };
    this.cache.set(id, merged);
    return merged;
  }
}
