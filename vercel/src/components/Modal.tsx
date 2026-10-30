import { useEffect, useId } from 'react';
import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';

interface ModalProps {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  width?: string;
}

export function Modal({ title, description, onClose, children, width = 'max-w-xl' }: ModalProps) {
  const titleId = useId();

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <motion.div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-ink/25 p-0 backdrop-blur-[3px] sm:items-center sm:p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <motion.section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`max-h-[92vh] w-full overflow-y-auto rounded-t-3xl border border-stitch bg-linen shadow-lift sm:rounded-3xl ${width}`}
        initial={{ opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 16, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 360, damping: 32 }}
      >
        <header className="flex items-start justify-between gap-4 border-b border-stitch px-6 py-5">
          <div>
            <h2 id={titleId} className="text-lg font-semibold tracking-[-0.02em] text-ink">{title}</h2>
            {description && <p className="mt-1 text-sm leading-6 text-stone">{description}</p>}
          </div>
          <button type="button" className="icon-button shrink-0" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </header>
        <div className="p-6">{children}</div>
      </motion.section>
    </motion.div>
  );
}
