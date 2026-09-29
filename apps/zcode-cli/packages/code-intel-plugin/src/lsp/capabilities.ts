export const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ["utf-16"] },
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: true },
    publishDiagnostics: { relatedInformation: true, versionSupport: true },
    diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
    hover: { contentFormat: ["markdown", "plaintext"] },
    definition: { linkSupport: true },
    typeDefinition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    rename: { prepareSupport: true },
    codeAction: {
      codeActionLiteralSupport: {
        codeActionKind: {
          valueSet: [
            "", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite",
            "source", "source.organizeImports", "source.fixAll",
          ],
        },
      },
      isPreferredSupport: true,
      resolveSupport: { properties: ["edit"] },
      dataSupport: true,
    },
  },
  workspace: {
    applyEdit: true,
    workspaceEdit: { documentChanges: true, resourceOperations: ["create", "rename", "delete"] },
    configuration: true,
    workspaceFolders: true,
    symbol: {},
    executeCommand: {},
    fileOperations: { willRename: true, didRename: true },
  },
  window: { workDoneProgress: true },
} as const;
