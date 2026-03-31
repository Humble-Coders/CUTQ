import * as React from "react";
import { cn } from "./utils";

export function Textarea({ className, ...props }) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "resize-none border-input placeholder:text-muted-foreground flex min-h-16 w-full rounded-md border px-3 py-2 text-base bg-input-background text-foreground transition-colors outline-none",
        "focus-visible:border-[#d4af37] focus-visible:ring-2 focus-visible:ring-[rgba(212,175,55,0.3)]",
        "disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      {...props}
    />
  );
}
