// NexQ UI kit: small, accessible, tokens-only primitives. No native select,
// `title` tooltip or colour input (they can escape hide-from-screen-share).
export { Menu, type MenuItemSpec, type MenuProps, type MenuTriggerProps } from "./Menu";
export { Select, Combobox, type SelectOption, type SelectProps } from "./Select";
export { Tooltip, TooltipBubble, type TooltipProps } from "./Tooltip";
export { Button, IconButton, buttonBase, buttonClasses, iconButtonClasses, type ButtonProps, type IconButtonProps, type ButtonVariant, type ButtonSize } from "./Button";
export { Dialog, ConfirmDialog, ModalLayer, buttonClass, type DialogProps, type ConfirmDialogProps } from "./Dialog";
export { SlideOver, type SlideOverProps } from "./SlideOver";
export { Switch, type SwitchProps } from "./Switch";
export { Segmented, type SegmentedOption, type SegmentedProps } from "./Segmented";
export { InlineEdit, type InlineEditProps } from "./InlineEdit";
export { ColorSwatches, type ColorSwatchesProps } from "./ColorSwatches";
export { EmptyState, type EmptyStateProps } from "./EmptyState";
export { Kbd } from "./Kbd";
export { WORKSPACE_HUES, hueColor, hueName, isWorkspaceHue, type WorkspaceHue, type WorkspaceHueId } from "./hues";
export { Portal, getPortalRoot, placeBox, anchorOf, type Placement } from "./portal";
export { Popover, AnchoredBox, type PopoverProps } from "./Popover";
export { useFocusTrap } from "./useFocusTrap";
