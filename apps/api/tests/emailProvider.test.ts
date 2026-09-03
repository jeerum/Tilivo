import { describe, expect, it } from 'vitest';
import { MockEmailProvider, NoopEmailProvider } from '../src/services/emailProvider';

describe('email providers', () => {
  it('noop provider is deterministic and never fails', async () => {
    const provider = new NoopEmailProvider();
    await expect(provider.send({
      to: 'x@example.com',
      subject: 's',
      text: 'body',
    })).resolves.toBeUndefined();
    expect(provider.kind).toBe('noop');
  });

  it('mock provider records recipient, subject, body and attachments', async () => {
    const provider = new MockEmailProvider();
    await provider.send({
      to: 'customer@example.com',
      subject: 'Invoice 1',
      text: 'attached',
      attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF') }],
    });
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]!.to).toBe('customer@example.com');
    expect(provider.sent[0]!.attachments![0]!.filename).toBe('invoice.pdf');
    expect(provider.sent[0]!.attachments![0]!.content.toString()).toBe('%PDF');
  });

  it('mock provider can simulate a failure without recording success', async () => {
    const provider = new MockEmailProvider();
    provider.failNext();
    await expect(provider.send({
      to: 'customer@example.com',
      subject: 'Invoice 2',
      text: 'will fail',
    })).rejects.toThrow(/failure/);
    expect(provider.sent).toHaveLength(0);
  });
});
