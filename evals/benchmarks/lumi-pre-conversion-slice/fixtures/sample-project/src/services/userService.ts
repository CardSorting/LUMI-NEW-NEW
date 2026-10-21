export interface UserRecord {
  id: string;
  name: string;
  createdAt: number;
  status: 'active' | 'archived';
}

export class UserService {
  private cache = new Map<string, UserRecord>();

  async findById(id: string): Promise<UserRecord | null> {
    return this.cache.get(id) || null;
  }

  async list(limit: number): Promise<UserRecord[]> {
    return Array.from(this.cache.values()).slice(0, limit);
  }

  async update(id: string, data: Partial<UserRecord>): Promise<UserRecord> {
    const current = this.cache.get(id) || { id, name: 'Default', createdAt: Date.now(), status: 'active' };
    const merged = { ...current, ...data };
    this.cache.set(id, merged);
    return merged;
  }
}
