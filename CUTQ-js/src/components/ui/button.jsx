import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "./utils";
import { buttonVariants } from "./buttonVariants";

export function Button({ className, variant, size, asChild = false, ...props }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}
