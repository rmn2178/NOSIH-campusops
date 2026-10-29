import type { HTMLAttributes } from "react";

export function ClothCard({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`rounded-2xl border border-[#E6E4DC] bg-white shadow-cloth ${className}`} {...props} />;
}
