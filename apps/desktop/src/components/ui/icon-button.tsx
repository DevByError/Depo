import type { LucideIcon } from "lucide-react";
import { Button } from "./button";
import { Tooltip } from "./tooltip";

export function IconButton({
  icon: Icon,
  label,
  onClick,
  pressed,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  pressed?: boolean;
}) {
  return (
    <Tooltip content={label}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        {...(pressed !== undefined ? { "aria-pressed": pressed } : {})}
        onClick={onClick}
        className={pressed ? "bg-hover text-fg" : undefined}
      >
        <Icon />
      </Button>
    </Tooltip>
  );
}
