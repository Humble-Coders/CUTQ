import * as React from "react";
import { cn } from "./utils";

export function Input({ className, type, ...props }) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "border-input placeholder:text-muted-foreground flex h-9 w-full min-w-0 rounded-md border px-3 py-1 text-base bg-input-background text-foreground transition-colors outline-none",
        "focus-visible:border-[#d4af37] focus-visible:ring-2 focus-visible:ring-[rgba(212,175,55,0.3)]",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      {...props}
    />
  );
}
