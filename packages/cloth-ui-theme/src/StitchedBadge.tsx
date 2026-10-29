import type { HTMLAttributes } from "react";

export function StitchedBadge({ className = "", ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={`inline-flex items-center rounded-full border border-[#E6E4DC] bg-[#F3F1EC] px-2.5 py-1 text-xs font-medium ${className}`} {...props} />;
}
