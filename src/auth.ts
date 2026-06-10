import type { Request, Response, NextFunction } from 'express';

export interface AuthConfig {
  apiKey: string;
}

/**
 * Express middleware that validates Bearer token or x-api-key header.
 * 
 * Returns plain JSON 401 responses WITHOUT the WWW-Authenticate header
 * to prevent MCP clients from attempting OAuth 2.1 discovery flows.
 */
export function createAuthMiddleware(config: AuthConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/health') return next();

    const token =
      req.headers['x-api-key'] as string ||
      req.headers['authorization']?.replace('Bearer ', '') ||
      (req.query['apiKey'] as string);

    if (!token || token !== config.apiKey) {
      console.error(`Unauthorized access attempt from ${req.ip}`);
      return res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Invalid or missing API key' },
        id: null,
      });
    }
    next();
  };
}

/**
 * Blocks OAuth 2.1 discovery endpoints that MCP clients probe for.
 * 
 * Without this, servers return HTML 404 pages which clients can't parse,
 * causing cascading failures in the OAuth DCR flow.
 */
export function blockOAuthDiscovery(app: {
  all: (path: string, handler: (req: Request, res: Response) => void) => void;
  post: (path: string, handler: (req: Request, res: Response) => void) => void;
}) {
  app.all('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.all('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.post('/register', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'Dynamic client registration is not supported' });
  });
}
