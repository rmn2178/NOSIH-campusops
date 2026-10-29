import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Camera, ImagePlus, LoaderCircle, UploadCloud, X } from 'lucide-react';
import { cx } from '../lib/format';

interface PhotoUploaderProps {
  file: File | null;
  onChange: (file: File | null) => void;
  disabled?: boolean;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function PhotoUploader({ file, onChange, disabled = false }: PhotoUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState('');
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!file) {
      setPreview('');
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const acceptFile = (nextFile?: File) => {
    if (!nextFile) return;
    if (!nextFile.type.startsWith('image/')) {
      setError('Choose an image file (JPG, PNG, WEBP, or HEIC).');
      return;
    }
    if (nextFile.size > MAX_IMAGE_BYTES) {
      setError('Images must be 8 MB or smaller.');
      return;
    }
    setError('');
    onChange(nextFile);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!disabled) acceptFile(event.dataTransfer.files[0]);
  };

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        disabled={disabled}
        onChange={(event) => {
          acceptFile(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      {file && preview ? (
        <div className="relative overflow-hidden rounded-2xl border border-stitch bg-silk">
          <img src={preview} alt="Complaint evidence preview" className="h-64 w-full object-cover" />
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 bg-gradient-to-t from-ink/70 to-transparent px-4 pb-4 pt-12 text-white">
            <ImagePlus size={17} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{file.name}</p>
              <p className="mono mt-0.5 text-[10px] opacity-80">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
            </div>
            <button
              type="button"
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/15 backdrop-blur transition hover:bg-white/25"
              onClick={() => onChange(null)}
              disabled={disabled}
              aria-label="Remove photo"
            >
              <X size={17} />
            </button>
          </div>
        </div>
      ) : (
        <div
          onDragEnter={(event) => {
            event.preventDefault();
            if (!disabled) setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            if (event.currentTarget === event.target) setDragging(false);
          }}
          onDrop={handleDrop}
          className={cx('flex flex-col items-center rounded-2xl border border-dashed px-5 py-8 text-center transition', dragging ? 'border-ink/50 bg-white' : 'border-stitch bg-silk/60')}
        >
          <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-stitch bg-white text-stone">
            <UploadCloud size={20} strokeWidth={1.6} />
          </span>
          <p className="text-sm font-medium">Drop photo evidence here</p>
          <p className="mt-1 text-xs leading-5 text-stone">or use your camera · up to 8 MB</p>
          <button type="button" className="btn-secondary mt-4" onClick={() => inputRef.current?.click()} disabled={disabled}>
            <Camera size={16} /> Choose or take photo
          </button>
        </div>
      )}
      {disabled && file && (
        <p className="mt-2 flex items-center gap-2 text-xs text-stone"><LoaderCircle size={13} className="animate-spin" /> Uploading evidence securely…</p>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}
    </div>
  );
}
