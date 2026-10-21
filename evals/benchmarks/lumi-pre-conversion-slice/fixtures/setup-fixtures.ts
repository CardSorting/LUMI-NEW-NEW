import * as fs from "node:fs"
import * as path from "node:path"

export function setupFixtures(baseDir: string) {
	const sampleDir = path.join(baseDir, "sample-project")
	fs.mkdirSync(path.join(sampleDir, "src/controllers"), { recursive: true })
	fs.mkdirSync(path.join(sampleDir, "src/models"), { recursive: true })
	fs.mkdirSync(path.join(sampleDir, "src/services"), { recursive: true })
	fs.mkdirSync(path.join(sampleDir, "src/utils"), { recursive: true })
	fs.mkdirSync(path.join(sampleDir, "docs"), { recursive: true })
	fs.mkdirSync(path.join(sampleDir, "tests"), { recursive: true })

	fs.writeFileSync(
		path.join(sampleDir, "package.json"),
		JSON.stringify(
			{
				name: "sample-ecommerce-service",
				version: "1.0.0",
				main: "src/index.ts",
				scripts: { test: "mocha tests/**/*.test.ts" },
				dependencies: { express: "^4.19.2", zod: "^3.22.4" },
			},
			null,
			2,
		),
	)

	fs.writeFileSync(
		path.join(sampleDir, "tsconfig.json"),
		JSON.stringify(
			{
				compilerOptions: {
					target: "ES2022",
					module: "commonjs",
					strict: true,
					esModuleInterop: true,
				},
				include: ["src/**/*", "tests/**/*"],
			},
			null,
			2,
		),
	)

	// Generate 25 realistic files across directories
	const controllers = ["User", "Order", "Product", "Inventory", "Payment", "Webhook", "Health", "Analytics"]
	for (const name of controllers) {
		const content = `import { Request, Response } from 'express';
import { ${name}Service } from '../services/${name.toLowerCase()}Service';

export class ${name}Controller {
  private service: ${name}Service;

  constructor() {
    this.service = new ${name}Service();
  }

  public async get${name}ById(req: Request, res: Response): Promise<void> {
    try {
      const id = req.params.id;
      const result = await this.service.findById(id);
      if (!result) {
        res.status(404).json({ error: '${name} not found' });
        return;
      }
      res.status(200).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  public async list${name}s(req: Request, res: Response): Promise<void> {
    const limit = parseInt(req.query.limit as string || '20', 10);
    const items = await this.service.list(limit);
    res.json({ total: items.length, items });
  }

  public async update${name}(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const updated = await this.service.update(id, req.body);
    res.json(updated);
  }
}
`
		fs.writeFileSync(path.join(sampleDir, `src/controllers/${name.toLowerCase()}Controller.ts`), content)
	}

	const services = ["User", "Order", "Product", "Inventory", "Payment", "Webhook", "Health", "Analytics"]
	for (const name of services) {
		const content = `export interface ${name}Record {
  id: string;
  name: string;
  createdAt: number;
  status: 'active' | 'archived';
}

export class ${name}Service {
  private cache = new Map<string, ${name}Record>();

  async findById(id: string): Promise<${name}Record | null> {
    return this.cache.get(id) || null;
  }

  async list(limit: number): Promise<${name}Record[]> {
    return Array.from(this.cache.values()).slice(0, limit);
  }

  async update(id: string, data: Partial<${name}Record>): Promise<${name}Record> {
    const current = this.cache.get(id) || { id, name: 'Default', createdAt: Date.now(), status: 'active' };
    const merged = { ...current, ...data };
    this.cache.set(id, merged);
    return merged;
  }
}
`
		fs.writeFileSync(path.join(sampleDir, `src/services/${name.toLowerCase()}Service.ts`), content)
	}

	for (let i = 1; i <= 5; i++) {
		fs.writeFileSync(
			path.join(sampleDir, `src/utils/helper${i}.ts`),
			`export function computeHash${i}(input: string): string {\n  let h = 0;\n  for (let j = 0; j < input.length; j++) h = (h << 5) - h + input.charCodeAt(j);\n  return (h >>> 0).toString(16);\n}\n`,
		)
	}

	fs.writeFileSync(
		path.join(sampleDir, "docs/architecture.md"),
		`# Architecture Overview\n\nThis microservice implements high-throughput checkout orchestration with event sourcing and idempotent retries.\n`,
	)

	fs.writeFileSync(
		path.join(sampleDir, "tests/orderController.test.ts"),
		`import { describe, it } from 'mocha';\nimport assert from 'node:assert';\n\ndescribe('OrderController', () => {\n  it('verifies initial stock', () => {\n    assert.equal(1 + 1, 2);\n  });\n});\n`,
	)

	// Target file for diff & mutation benchmarks
	const targetController = `import { Request, Response } from 'express';

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
      throw new Error(\`Route \${path} already registered\`);
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
`
	fs.writeFileSync(path.join(baseDir, "target-controller.ts"), targetController)

	// Multi-block diff targeting target-controller.ts
	const diffContent = `<<<<<<< SEARCH
  public getRouteCount(): number {
    return this.routes.size;
  }

  public getTimeout(): number {
    return this.config.timeoutMs;
  }
=======
  public getRouteCount(): number {
    return this.routes.size;
  }

  public getActiveRoutes(): string[] {
    return Array.from(this.routes.keys());
  }

  public getTimeout(): number {
    return Math.max(100, this.config.timeoutMs);
  }
>>>>>>> REPLACE`

	fs.writeFileSync(path.join(baseDir, "target-patch.diff"), diffContent)
}

if (require.main === module || process.argv[1]?.endsWith("setup-fixtures.ts")) {
	setupFixtures(path.join(__dirname))
	console.log("Fixtures initialized successfully.")
}
