import { Request, Response } from 'express';

export interface RouteConfig {
  prefix: string;
  timeoutMs: number;
  rateLimit: number;
}

export class GatewayRouter {
  private config: RouteConfig;
  private routes = new Map<string, (req: Request, res: Response) => Promise<void>>();

  constructor(config: RouteConfig) {
    this.config = config;
  }

  public registerRoute(path: string, handler: (req: Request, res: Response) => Promise<void>): void {
    if (this.routes.has(path)) {
      throw new Error(`Route ${path} already registered`);
    }
    this.routes.set(path, handler);
  }

  public async handleRequest(path: string, req: Request, res: Response): Promise<void> {
    const handler = this.routes.get(path);
    if (!handler) {
      res.status(404).send('Not Found');
      return;
    }
    await handler(req, res);
  }

  public getRouteCount(): number {
    return this.routes.size;
  }

  public getTimeout(): number {
    return this.config.timeoutMs;
  }
}
