import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(process.env.IMAGE_TEST_TOOLS ? path.join(process.env.IMAGE_TEST_TOOLS, 'package.json') : import.meta.url)
const ts = require('typescript')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const src = path.join(repo, 'apps/web/src')
const contractsPath = path.join(repo, 'packages/contracts/src/index.ts')
const contractSource = ts.createSourceFile(contractsPath, readFileSync(contractsPath, 'utf8'), ts.ScriptTarget.Latest, true)
const selected = new Set(['Attachment', 'ApiError', 'Result'])
const contractBoundary = contractSource.statements.filter(node => node.name && selected.has(node.name.text)).map(node => node.getText(contractSource)).join('\n') + '\nexport declare const EXPECTED_USER_HEADER: string; export declare const MAX_ATTACHMENT_BYTES: number;'
assert.equal(selected.size, contractSource.statements.filter(node => node.name && selected.has(node.name.text)).length)
const virtual = path.join(src, '__attachment_contract_boundary.d.ts')
const options = { target: ts.ScriptTarget.ES2022, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX, strict: true, skipLibCheck: true, noEmit: true, types: [], esModuleInterop: true }
const host = ts.createCompilerHost(options)
const originalGetSourceFile = host.getSourceFile.bind(host)
host.getSourceFile = (name, language, ...rest) => name === virtual ? ts.createSourceFile(name, contractBoundary, language, true) : originalGetSourceFile(name, language, ...rest)
const reactTypes = path.dirname(require.resolve('@types/react/package.json'))
host.resolveModuleNames = (names, containingFile) => names.map(name => {
  if (name === '@anyone-im/contracts') return { resolvedFileName: virtual, extension: ts.Extension.Dts }
  if (name === 'react' || name.startsWith('react/')) {
    const suffix = name === 'react' ? 'index' : name.slice('react/'.length)
    const resolvedFileName = path.join(reactTypes, `${suffix}.d.ts`)
    if (existsSync(resolvedFileName)) return { resolvedFileName, extension: ts.Extension.Dts }
  }
  return ts.resolveModuleName(name, containingFile, options, host).resolvedModule
})
const roots = ['AttachedImage.tsx', 'useNearViewport.ts'].map(name => path.join(src, name))
const program = ts.createProgram(roots, options, host)
const diagnostics = ts.getPreEmitDiagnostics(program)
if (diagnostics.length) { console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: name => name, getCurrentDirectory: () => repo, getNewLine: () => '\n' })); process.exitCode = 1 }
else console.log('PASS: strict scoped attachment component/helper typecheck (real API, session context, upload helper; source-extracted contracts boundary).')
for (const file of ['apps/web/tests/attached-image.spec.ts', 'apps/web/tests/fixtures/attached-image.tsx', 'apps/web/tests/session-lock.spec.ts', 'apps/web/src/Workspace.tsx', 'apps/web/src/RoomDetails.tsx']) {
  const result = ts.transpileModule(readFileSync(path.join(repo, file), 'utf8'), { fileName: file, compilerOptions: options, reportDiagnostics: true })
  if (result.diagnostics?.length) { console.error(result.diagnostics); process.exitCode = 1 }
  else console.log(`PASS: TypeScript syntax ${file} (not Playwright execution or test semantic typecheck).`)
}
