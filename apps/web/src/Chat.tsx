import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Paperclip, Send, X } from 'lucide-react';
import {
  api,
  type ChatAttachment,
  type ChatPending,
  type ChatSessionMessage,
  type HostLlmInfo,
} from './api.js';
import { Button, Panel } from './components.jsx';

type PendingFile = {
  localId: string;
  file: File;
  previewUrl?: string;
};

/**
 * Per-host agent chat. The model may run on this host's Ollama or fall back to
 * the operator laptop — tools always execute against the selected host.
 * Approval follows AGENT_APPROVAL_MODE (`trust` = auto-run without prompts).
 */
export function HostChat({
  hostId,
  hostName,
  llm,
}: {
  hostId: string;
  hostName: string;
  llm?: HostLlmInfo | null;
}) {
  const queryClient = useQueryClient();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [typedConfirm, setTypedConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sessions = useQuery({
    queryKey: ['chat-sessions', hostId],
    queryFn: () => api.chatSessions(hostId),
  });

  const thread = useQuery({
    queryKey: ['chat-thread', sessionId],
    queryFn: () => api.chatThread(sessionId!),
    enabled: Boolean(sessionId),
    refetchInterval: false,
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [thread.data?.messages.length, thread.data?.pending]);

  useEffect(() => {
    return () => {
      for (const p of pendingFiles) {
        if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
      }
    };
  }, [pendingFiles]);

  const ensureSession = async (): Promise<string> => {
    if (sessionId) return sessionId;
    const created = await api.createChatSession(hostId, `Chat · ${hostName}`);
    setSessionId(created.id);
    await queryClient.invalidateQueries({ queryKey: ['chat-sessions', hostId] });
    return created.id;
  };

  const addFiles = (files: FileList | File[]) => {
    const next: PendingFile[] = [];
    for (const file of Array.from(files)) {
      if (file.size > 25 * 1024 * 1024) {
        setError(`${file.name} is larger than 25 MB.`);
        continue;
      }
      next.push({
        localId: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`,
        file,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
      });
    }
    if (next.length > 0) setPendingFiles((prev) => [...prev, ...next]);
  };

  const removePending = (localId: string) => {
    setPendingFiles((prev) => {
      const doomed = prev.find((p) => p.localId === localId);
      if (doomed?.previewUrl) URL.revokeObjectURL(doomed.previewUrl);
      return prev.filter((p) => p.localId !== localId);
    });
  };

  const send = useMutation({
    mutationFn: async (payload: { text: string; files: PendingFile[] }) => {
      const id = await ensureSession();
      const attachmentIds: string[] = [];
      for (const pending of payload.files) {
        const uploaded = await api.uploadAttachment(pending.file);
        attachmentIds.push(uploaded.id);
      }
      const result = await api.sendChatMessage(id, payload.text, attachmentIds);
      return { ...result, sessionId: id };
    },
    onSuccess: async (result) => {
      setDraft('');
      setPendingFiles((prev) => {
        for (const p of prev) {
          if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
        }
        return [];
      });
      setError(null);
      setSessionId(result.sessionId);
      await queryClient.invalidateQueries({ queryKey: ['chat-thread', result.sessionId] });
      await queryClient.invalidateQueries({ queryKey: ['chat-sessions', hostId] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const approve = useMutation({
    mutationFn: (typedConfirmation?: string) =>
      api.approveChat(sessionId!, typedConfirmation),
    onSuccess: async () => {
      setTypedConfirm('');
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['chat-thread', sessionId] });
      await queryClient.invalidateQueries({ queryKey: ['audit'] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const deny = useMutation({
    mutationFn: () => api.denyChat(sessionId!),
    onSuccess: async () => {
      setTypedConfirm('');
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['chat-thread', sessionId] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const pending: ChatPending | null = thread.data?.pending ?? null;
  const messages: ChatSessionMessage[] = thread.data?.messages ?? [];
  const busy = send.isPending || approve.isPending || deny.isPending;
  const canSend = Boolean(draft.trim() || pendingFiles.length > 0);

  const submit = () => {
    const text = draft.trim();
    if ((!text && pendingFiles.length === 0) || busy || pending) return;
    send.mutate({ text, files: pendingFiles });
  };

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <MessageSquare size={15} />
          Chat · {hostName}
        </span>
      }
      className="flex min-h-[28rem] flex-col"
      actions={
        <div className="flex items-center gap-2">
          <select
            className="mono max-w-[14rem] truncate rounded border border-[var(--color-edge)] bg-[var(--color-panel)] px-2 py-1 text-xs"
            value={sessionId ?? ''}
            onChange={(e) => setSessionId(e.target.value || null)}
          >
            <option value="">New chat</option>
            {(sessions.data?.sessions ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.title ?? s.id.slice(0, 8)}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            onClick={async () => {
              const created = await api.createChatSession(hostId, `Chat · ${hostName}`);
              setSessionId(created.id);
              await queryClient.invalidateQueries({ queryKey: ['chat-sessions', hostId] });
            }}
          >
            New
          </Button>
        </div>
      }
    >
      <p className="mb-3 text-xs text-[var(--color-muted)]">
        Talk to an LLM that runs commands on <strong>{hostName}</strong> over SSH.
        Attach images/files with the paperclip (or paste an image).
      </p>
      {llm && (
        <div className="mb-3 rounded border border-[var(--color-edge)] bg-[var(--color-surface)] px-3 py-2 text-xs">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span>
              Chat model:{' '}
              <span className="mono font-medium text-[var(--color-ink)]">{llm.chatModel}</span>
            </span>
            <span className="mono text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
              {llm.where === 'this_host'
                ? 'on this host'
                : llm.where === 'forced_operator'
                  ? 'operator Ollama'
                  : llm.where === 'operator_fallback'
                    ? 'operator fallback'
                    : 'unavailable'}
            </span>
          </div>
          <p className="mt-1 text-[var(--color-muted)]">{llm.summary}</p>
          {llm.baseUrl && (
            <p className="mono mt-1 text-[10px] text-[var(--color-muted)]">{llm.baseUrl}</p>
          )}
        </div>
      )}

      <div className="mb-3 flex min-h-[16rem] flex-1 flex-col gap-2 overflow-y-auto rounded border border-[var(--color-edge)] bg-[var(--color-surface)] p-3">
        {messages.length === 0 && !busy && (
          <p className="m-auto text-sm text-[var(--color-muted)]">
            Ask anything about this machine — or attach a file/image to send.
          </p>
        )}
        {messages
          .filter((m) => {
            if (m.role === 'user' || m.role === 'tool') return true;
            if (m.role !== 'assistant') return false;
            const text = (m.content ?? '').trim();
            const hasAttachments = Boolean(m.attachments?.length);
            // Hide intermediate "tool call only" shells and blank finals.
            if (!text && !hasAttachments) return false;
            return true;
          })
          .map((m) => (
            <Bubble key={m.id} message={m} />
          ))}
        {busy && (
          <p className="mono text-xs text-[var(--color-muted)]">Thinking…</p>
        )}
        <div ref={bottomRef} />
      </div>

      {pending && (
        <div className="mb-3 rounded border border-[var(--color-warn)]/50 bg-[var(--color-warn)]/10 p-3">
          <p className="mb-1 text-sm font-medium text-[var(--color-warn)]">
            Approval required · {pending.tool}
          </p>
          <p className="mb-2 text-xs text-[var(--color-muted)]">{pending.reason}</p>
          <pre className="mono mb-3 max-h-40 overflow-auto rounded border border-[var(--color-edge)] bg-[var(--color-panel)] p-2 text-xs whitespace-pre-wrap">
            {pending.subject}
            {pending.body ? `\n\n${pending.body}` : ''}
          </pre>
          {pending.requiresTypedConfirmation && (
            <label className="mb-2 block text-xs">
              Type <span className="mono font-medium">{pending.typedConfirmationPhrase}</span> to
              confirm
              <input
                value={typedConfirm}
                onChange={(e) => setTypedConfirm(e.target.value)}
                className="mt-1 w-full rounded border border-[var(--color-edge)] bg-[var(--color-panel)] px-2 py-1"
              />
            </label>
          )}
          <div className="flex gap-2">
            <Button
              tone="primary"
              size="sm"
              disabled={
                busy ||
                (pending.requiresTypedConfirmation &&
                  typedConfirm !== pending.typedConfirmationPhrase)
              }
              onClick={() =>
                approve.mutate(
                  pending.requiresTypedConfirmation ? typedConfirm : undefined,
                )
              }
            >
              Approve
            </Button>
            <Button tone="danger" size="sm" disabled={busy} onClick={() => deny.mutate()}>
              Deny
            </Button>
          </div>
        </div>
      )}

      {error && <p className="mb-2 text-xs text-[var(--color-bad)]">{error}</p>}

      {pendingFiles.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {pendingFiles.map((p) => (
            <div
              key={p.localId}
              className="relative flex items-center gap-2 rounded border border-[var(--color-edge)] bg-[var(--color-panel)] p-1.5 pr-7"
            >
              {p.previewUrl ? (
                <img src={p.previewUrl} alt={p.file.name} className="h-12 w-12 rounded object-cover" />
              ) : (
                <span className="mono px-2 text-[10px] text-[var(--color-muted)]">FILE</span>
              )}
              <span className="max-w-[8rem] truncate text-xs">{p.file.name}</span>
              <button
                type="button"
                className="absolute top-1 right-1 rounded p-0.5 text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                onClick={() => removePending(p.localId)}
                aria-label={`Remove ${p.file.name}`}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <Button
          size="sm"
          disabled={busy || Boolean(pending)}
          onClick={() => fileInputRef.current?.click()}
          title="Attach files or images"
        >
          <Paperclip size={14} />
        </Button>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const items = e.clipboardData?.files;
            if (items && items.length > 0) {
              const images = Array.from(items).filter((f) => f.type.startsWith('image/'));
              if (images.length > 0) {
                e.preventDefault();
                addFiles(images);
              }
            }
          }}
          disabled={busy || Boolean(pending)}
          placeholder={
            pending
              ? 'Approve or deny the pending action first…'
              : `Message ${hostName}… (paste or attach images)`
          }
          className="flex-1 rounded border border-[var(--color-edge)] bg-[var(--color-panel)] px-3 py-2 text-sm"
        />
        <Button tone="primary" disabled={busy || Boolean(pending) || !canSend} onClick={submit}>
          <Send size={14} />
        </Button>
      </form>
    </Panel>
  );
}

function Bubble({ message }: { message: ChatSessionMessage }) {
  const attachments = (message.attachments ?? []) as ChatAttachment[];
  const images = attachments.filter((a) => a.kind === 'image');
  const files = attachments.filter((a) => a.kind !== 'image');

  if (message.role === 'tool') {
    return (
      <div className="rounded border border-[var(--color-edge)] bg-[var(--color-panel)] p-2">
        <div className="mono mb-1 text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
          tool result
        </div>
        <pre className="mono max-h-48 overflow-auto text-xs whitespace-pre-wrap text-[var(--color-muted)]">
          {(message.content ?? '').slice(0, 4000)}
        </pre>
        <AttachmentGallery images={images} files={files} />
      </div>
    );
  }

  const mine = message.role === 'user';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
          mine
            ? 'bg-[var(--color-accent)]/15 text-[var(--color-ink)]'
            : 'bg-[var(--color-panel)] text-[var(--color-ink)]'
        }`}
      >
        <div className="mono mb-1 text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
          {mine ? 'you' : 'assistant'}
        </div>
        {(message.content ?? '').trim() ? (
          message.content
        ) : images.length || files.length ? null : (
          <span className="text-[var(--color-muted)] italic">Working…</span>
        )}
        <AttachmentGallery images={images} files={files} />
      </div>
    </div>
  );
}

function AttachmentGallery({
  images,
  files,
}: {
  images: ChatAttachment[];
  files: ChatAttachment[];
}) {
  if (images.length === 0 && files.length === 0) return null;
  return (
    <div className="mt-2 space-y-2">
      {images.map((img) => (
        <a key={img.id} href={img.url} target="_blank" rel="noreferrer" className="block">
          <img
            src={img.url}
            alt={img.filename}
            className="max-h-80 max-w-full rounded border border-[var(--color-edge)]"
          />
        </a>
      ))}
      {files.map((f) => (
        <a
          key={f.id}
          href={f.url}
          target="_blank"
          rel="noreferrer"
          className="mono block text-xs text-[var(--color-accent)] underline"
        >
          {f.filename}
          {f.bytes != null ? ` (${f.bytes} bytes)` : ''}
        </a>
      ))}
    </div>
  );
}
