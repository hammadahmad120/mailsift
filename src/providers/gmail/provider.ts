import { MailError } from '../../errors.js';
import type {
  MailProvider,
  MailboxProfile,
  RawAttachment,
  RawMessage,
  SearchFilters,
  SearchPage,
  SearchResult,
} from '../types.js';
import type { GmailClient } from './client.js';

/** Shape of Gmail's `users.getProfile` response. */
interface GmailProfileResponse {
  emailAddress?: unknown;
  messagesTotal?: unknown;
  threadsTotal?: unknown;
}

export interface GmailProviderOptions {
  client: GmailClient;
  /** Granted OAuth scopes, supplied by the scope check (task 2.2). Empty until then. */
  scopes?: readonly string[];
}

/**
 * Gmail implementation of MailProvider.
 * Phase 1: getProfile only. Phase 2 adds search, getMessage, getThread. Phase 3 adds getAttachment.
 */
export class GmailProvider implements MailProvider {
  readonly name = 'gmail' as const;
  private readonly client: GmailClient;
  private readonly scopes: readonly string[];

  constructor(options: GmailProviderOptions) {
    this.client = options.client;
    this.scopes = options.scopes ?? [];
  }

  async getProfile(): Promise<MailboxProfile> {
    const data = await this.client.get<GmailProfileResponse>('profile');

    if (typeof data.emailAddress !== 'string') {
      throw new MailError('PROVIDER_ERROR', 'Gmail profile response had no emailAddress.');
    }

    return {
      email_address: data.emailAddress,
      messages_total: asCount(data.messagesTotal),
      threads_total: asCount(data.threadsTotal),
      provider: this.name,
      scopes: [...this.scopes],
      read_only: true,
    };
  }

  search(_filters: SearchFilters, _page: SearchPage): Promise<SearchResult> {
    return Promise.reject(notImplemented('search'));
  }

  getMessage(_messageId: string): Promise<RawMessage> {
    return Promise.reject(notImplemented('getMessage'));
  }

  getThread(_threadId: string): Promise<RawMessage[]> {
    return Promise.reject(notImplemented('getThread'));
  }

  getAttachment(_messageId: string, _attachmentId: string): Promise<RawAttachment> {
    return Promise.reject(notImplemented('getAttachment'));
  }
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function notImplemented(method: string): MailError {
  return new MailError('PROVIDER_ERROR', `GmailProvider.${method} is not implemented yet.`);
}
