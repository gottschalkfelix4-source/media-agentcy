import { ChevronDown, Info, Shield } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Message } from '../api';
import { Button, Spinner, WaText, cx, fmtDay, fmtTime, parseDate } from './ui';

function EventNote({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex justify-center">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex max-w-[85%] items-start gap-1.5 rounded-lg bg-surface/70 px-2.5 py-1 text-left text-[11px] text-fg-3 shadow-sm backdrop-blur"
        title="Interne Systemnachricht an den Bot – der Nutzer sieht sie nicht"
      >
        <Info className="mt-px size-3 shrink-0" />
        <span className={open ? 'whitespace-pre-wrap' : 'line-clamp-1'}>{content}</span>
      </button>
    </div>
  );
}

function Bubble({ m, incomingLabel }: { m: Message; incomingLabel?: string }) {
  const out = m.role === 'assistant';
  const admin = m.via === 'admin';
  return (
    <div className={cx('flex', out ? 'justify-end' : 'justify-start')}>
      <div
        className={cx(
          'relative max-w-[85%] rounded-xl px-3 py-1.5 text-[13.5px] leading-snug text-fg shadow-sm sm:max-w-[70%]',
          out ? (admin ? 'rounded-tr-sm bg-bubble-admin' : 'rounded-tr-sm bg-bubble-out') : 'rounded-tl-sm bg-bubble-in',
          m.summarized ? 'opacity-70' : undefined,
        )}
      >
        {admin && (
          <p className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold text-info">
            <Shield className="size-3" /> Du (Admin)
          </p>
        )}
        {!out && incomingLabel && <p className="mb-0.5 text-[11px] font-semibold text-accent-text">{incomingLabel}</p>}
        <WaText text={m.content} />
        <span className="float-right mt-1 ml-3 translate-y-0.5 text-[10px] text-fg-3" title={m.summarized ? 'Bereits ins Gedächtnis zusammengefasst' : undefined}>
          {fmtTime(m.created_at)}
        </span>
      </div>
    </div>
  );
}

/** WhatsApp-like transcript with day separators and sticky-to-bottom scrolling. */
export function ChatTranscript({
  messages,
  loadingOlder,
  onLoadOlder,
  hasOlder,
  typing,
  empty,
  incomingLabel,
  className,
}: {
  messages: Message[];
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  hasOlder?: boolean;
  typing?: ReactNode;
  empty?: ReactNode;
  incomingLabel?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const prevFirst = useRef<number | undefined>(undefined);
  const prevHeight = useRef(0);
  const [showJump, setShowJump] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const first = messages[0]?.id;
    if (prevFirst.current !== undefined && first !== undefined && first < prevFirst.current) {
      // older page prepended → keep the viewport where it was
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevFirst.current = first;
    prevHeight.current = el.scrollHeight;
  }, [messages, typing]);

  const onScroll = () => {
    const el = ref.current!;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = atBottom;
    setShowJump(!atBottom);
    prevHeight.current = el.scrollHeight;
  };

  let lastDay = '';
  return (
    <div className={cx('relative min-h-0', className)}>
      <div ref={ref} onScroll={onScroll} className="h-full overflow-y-auto bg-chat px-3 py-4 sm:px-6">
        {hasOlder && onLoadOlder && (
          <div className="mb-3 flex justify-center">
            <Button size="sm" loading={loadingOlder} onClick={onLoadOlder}>
              Ältere Nachrichten laden
            </Button>
          </div>
        )}
        {messages.length === 0 && !typing && empty}
        <div className="space-y-1.5">
          {messages.map((m) => {
            const day = parseDate(m.created_at).toLocaleDateString('sv-SE');
            const sep = day !== lastDay;
            lastDay = day;
            return (
              <div key={m.id}>
                {sep && (
                  <div className="my-3 flex justify-center">
                    <span className="rounded-md bg-surface/80 px-2.5 py-0.5 text-[11px] font-medium text-fg-3 shadow-sm">{fmtDay(day)}</span>
                  </div>
                )}
                {m.role === 'event' ? <EventNote content={m.content} /> : <Bubble m={m} incomingLabel={incomingLabel} />}
              </div>
            );
          })}
          {typing && (
            <div className="flex justify-end pt-1">
              <div className="flex items-center gap-2 rounded-xl bg-bubble-out px-3 py-2 text-xs text-fg-2 shadow-sm">
                <Spinner className="size-3.5" /> {typing}
              </div>
            </div>
          )}
        </div>
      </div>
      {showJump && (
        <button
          type="button"
          aria-label="Nach unten"
          onClick={() => {
            stick.current = true;
            ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' });
          }}
          className="absolute right-4 bottom-4 flex size-9 items-center justify-center rounded-full border border-line bg-surface text-fg-2 shadow-lg hover:text-fg"
        >
          <ChevronDown className="size-5" />
        </button>
      )}
    </div>
  );
}
