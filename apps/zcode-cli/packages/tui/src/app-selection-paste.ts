import type { PasteEvent } from "@mbears/opentui-core";
import { usePaste } from "@mbears/opentui-react";
import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { SelectionState } from "./app-model.js";
import {
  appendSelectionInputText,
  sanitizeSelectionInputPaste,
} from "./app-selection-keyboard.js";

/**
 * 终端的 bracketed paste（Windows Terminal Ctrl+V / 右键）以独立 paste 事件送达，不走 keypress。
 * 选择面板的输入框（如 /login 的 Coding Plan API Key）以前只处理按键，粘贴内容被丢弃；
 * 这里在输入框打开且无审批弹窗时接管 paste，并阻止它落进后面的主输入框。
 */
export function useSelectionInputPaste(input: {
  approvalPending: boolean;
  readOnlyView: boolean;
  selection: SelectionState | undefined;
  setSelection: Dispatch<SetStateAction<SelectionState | undefined>>;
}): void {
  const { approvalPending, readOnlyView, selection, setSelection } = input;
  const inputOpen = Boolean(selection?.input);
  usePaste(
    useCallback(
      (event: PasteEvent) => {
        if (readOnlyView || approvalPending || !inputOpen) return;
        event.preventDefault();
        event.stopPropagation();
        const text = sanitizeSelectionInputPaste(new TextDecoder().decode(event.bytes));
        if (text) appendSelectionInputText(setSelection, text);
      },
      [approvalPending, inputOpen, readOnlyView, setSelection],
    ),
  );
}
