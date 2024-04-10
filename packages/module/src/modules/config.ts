import { fileURLToPath, pathToFileURL } from 'node:url'
import { builtinModules } from 'node:module'
import fs from 'node:fs/promises'
import { addTemplate, createResolver, logger } from '@nuxt/kit'
import { stringifyImports } from 'unimport'
import type { Import } from 'unimport'
import { resolvePath } from 'mlly'
import type { Nuxt } from '@nuxt/schema'
import { relative, resolve, join, dirname } from 'pathe'
import { getPort } from 'get-port-please'
import type { NuxtESLintConfigOptions } from '@nuxt/eslint-config/flat'
import type { ESLintConfigGenAddon } from '../types'
import type { ConfigGenOptions, ModuleOptions } from '../module'
import { createAddonGlobals } from '../config-addons/globals'

const r = createResolver(import.meta.url)

export async function setupConfigGen(options: ModuleOptions, nuxt: Nuxt) {
  const {
    autoInit = true,
  } = typeof options.config !== 'boolean' ? options.config || {} : {}

  const defaultAddons = [
    createAddonGlobals(nuxt),
  ]

  nuxt.hook('prepare:types', ({ declarations }) => {
    declarations.push('/// <reference path="./eslint-typegen.d.ts" />')
  })

  const template = addTemplate({
    filename: 'eslint.config.mjs',
    write: true,
    async getContents() {
      const addons: ESLintConfigGenAddon[] = [
        ...defaultAddons,
      ]
      await nuxt.callHook('eslint:config:addons', addons)
      return generateESLintConfig(options, nuxt, addons)
    },
  })

  addTemplate({
    filename: 'eslint.config.d.mts',
    write: true,
    async getContents() {
      return [
        'import type { FlatConfigComposer, FlatConfigItem } from "eslint-flat-config-utils"',
        'import { defineFlatConfigs } from "@nuxt/eslint-config/flat"',
        'import type { NuxtESLintConfigOptionsResolved } from "@nuxt/eslint-config/flat"',
        '',
        'declare const configs: FlatConfigComposer<FlatConfigItem>',
        'declare const options: NuxtESLintConfigOptionsResolved',
        'declare const withNuxt: typeof defineFlatConfigs',
        'export default withNuxt',
        'export { withNuxt, defineFlatConfigs, configs, options }',
      ].join('\n')
    },
  })

  if (autoInit) {
    await initRootESLintConfig(nuxt, template.dst)
  }

  setupDevToolsIntegration(nuxt)
}

async function initRootESLintConfig(nuxt: Nuxt, generateConfigPath: string) {
  const { findUp } = await import('find-up')

  const hasFlatConfig = await findUp(
    [
      'eslint.config.js',
      'eslint.config.mjs',
      'eslint.config.cjs',
      'eslint.config.ts',
      'eslint.config.mts',
      'eslint.config.cts',
    ],
    {
      cwd: nuxt.options.rootDir,
    },
  )

  if (hasFlatConfig)
    return

  const targetPath = join(nuxt.options.rootDir, 'eslint.config.mjs')
  let relativeDistPath = relative(nuxt.options.rootDir, generateConfigPath)
  if (!relativeDistPath.startsWith('./') && !relativeDistPath.startsWith('../'))
    relativeDistPath = './' + relativeDistPath

  await fs.writeFile(
    targetPath,
    [
      '// @ts-check',
      `import withNuxt from '${relativeDistPath}'`,
      '',
      'export default withNuxt(',
      '  // Your custom configs here',
      ')',
      '',
    ].join('\n'),
    'utf-8',
  )

  logger.success(`ESLint config file created at ${targetPath}`)
  logger.info(`If you have .eslintrc or .eslintignore files, you might want to migrate them to the new config file`)
}

async function generateESLintConfig(options: ModuleOptions, nuxt: Nuxt, addons: ESLintConfigGenAddon[]) {
  const importLines: Import[] = []
  const configItems: string[] = []

  const config: ConfigGenOptions = {
    standalone: true,
    ...typeof options.config !== 'boolean' ? options.config || {} : {},
  }

  importLines.push(
    {
      from: 'eslint-flat-config-utils',
      name: 'composer',
    },
    {
      from: 'eslint-typegen',
      name: 'default',
      as: 'typegen',
    },
    {
      from: '@nuxt/eslint-config/flat',
      name: 'createConfigForNuxt',
    },
    {
      from: '@nuxt/eslint-config/flat',
      name: 'defineFlatConfigs',
    },
    {
      from: '@nuxt/eslint-config/flat',
      name: 'resolveOptions',
    },
  )

  const basicOptions: NuxtESLintConfigOptions = {
    features: config,
    dirs: getDirs(nuxt),
  }

  configItems.push(`// Nuxt Configs\ncreateConfigForNuxt(options)`)

  for (const addon of addons) {
    const resolved = await addon.getConfigs()
    if (resolved?.imports)
      importLines.push(...resolved.imports)
    if (resolved?.configs)
      configItems.push(...resolved.configs)
  }

  const imports = await Promise.all(importLines.map(async (line): Promise<Import> => {
    return {
      ...line,
      from: (line.from.match(/^\w+:/) || builtinModules.includes(line.from))
        ? line.from
        : pathToFileURL(await r.resolvePath(line.from)).toString(),
    }
  }))

  return [
    '// ESLint config generated by Nuxt',
    '/// <reference path="./eslint-typegen.d.ts" />',
    '',
    stringifyImports(imports, false),
    '',
    'export { defineFlatConfigs }',
    '',
    `export const configs = composer()`,
    '',
    `export const options = resolveOptions(${JSON.stringify(basicOptions, null, 2)})`,
    ``,
    `configs.append(`,
    configItems.join(',\n\n'),
    `)`,
    '',
    'export function withNuxt(...customs) {',
    '  return configs.clone().append(...customs).onResolved(configs => typegen(configs, { dtsPath: new URL("./eslint-typegen.d.ts", import.meta.url) }))',
    '}',
    '',
    'export default withNuxt',
  ].join('\n')
}

async function setupDevToolsIntegration(nuxt: Nuxt) {
  let viewerProcess: ReturnType<typeof import('@nuxt/devtools-kit')['startSubprocess']> | undefined
  let viewerPort: number | undefined
  let viewerUrl: string | undefined

  nuxt.hook('devtools:customTabs', (tabs) => {
    tabs.push({
      name: 'eslint-config',
      title: 'ESLint Config',
      icon: 'https://raw.githubusercontent.com/eslint/config-inspector/main/app/public/favicon.svg',
      view: viewerUrl
        ? {
            type: 'iframe',
            src: viewerUrl,
          }
        : {
            type: 'launch',
            description: 'Start ESLint config inspector to analyze the local ESLint configs',
            actions: [
              {
                label: 'Launch',
                pending: !!viewerProcess,
                handle: async () => {
                  const { startSubprocess } = await import('@nuxt/devtools-kit')
                  const inspectorBinPath = join(
                    dirname(await resolvePath(
                      '@eslint/config-inspector/package.json',
                      { url: dirname(fileURLToPath(import.meta.url)) },
                    )),
                    'bin.mjs',
                  )

                  viewerPort = await getPort({
                    port: 8123,
                    portRange: [8123, 10000],
                  })
                  viewerProcess = startSubprocess(
                    {
                      command: 'node',
                      args: [inspectorBinPath, '--no-open'],
                      cwd: nuxt.options.rootDir,
                      env: {
                        PORT: viewerPort.toString(),
                      },
                    },
                    {
                      id: 'eslint-config-inspector',
                      name: 'ESLint Config Viewer',
                    },
                    nuxt,
                  )
                  nuxt.callHook('devtools:customTabs:refresh')

                  // Wait for viewer to be ready
                  const url = `http://localhost:${viewerPort}`
                  for (let i = 0; i < 100; i++) {
                    if (await fetch(url).then(r => r.ok).catch(() => false))
                      break
                    await new Promise(resolve => setTimeout(resolve, 500))
                  }
                  await new Promise(resolve => setTimeout(resolve, 2000))
                  viewerUrl = url
                },
              },
            ],
          },
    })
  })
}

function getDirs(nuxt: Nuxt): NuxtESLintConfigOptions['dirs'] {
  const dirs: Required<NuxtESLintConfigOptions['dirs']> = {
    pages: [],
    composables: [],
    components: [],
    layouts: [],
    plugins: [],
    middleware: [],
    modules: [],
    servers: [],
    root: [nuxt.options.rootDir],
    src: [],
  }

  for (const layer of nuxt.options._layers) {
    const r = (t: string) => relative(nuxt.options.rootDir, resolve(layer.config.srcDir, t))

    dirs.src.push(r(''))
    dirs.pages.push(r(nuxt.options.dir.pages || 'pages'))
    dirs.layouts.push(r(nuxt.options.dir.layouts || 'layouts'))
    dirs.plugins.push(r(nuxt.options.dir.plugins || 'plugins'))
    dirs.middleware.push(r(nuxt.options.dir.middleware || 'middleware'))
    dirs.modules.push(r(nuxt.options.dir.modules || 'modules'))

    dirs.composables.push(r('composables'))
    dirs.composables.push(r('utils'))
    for (const dir of (layer.config.imports?.dirs ?? [])) {
      if (dir)
        dirs.composables.push(r(dir))
    }

    if (layer.config.components) {
      const options = layer.config.components || {}
      if (options !== true && 'dirs' in options) {
        for (const dir of options.dirs || []) {
          if (typeof dir === 'string')
            dirs.components.push(r(dir))
          else if (dir && 'path' in dir && typeof dir.path === 'string')
            dirs.components.push(r(dir.path))
        }
      }
    }
    else {
      dirs.components.push(r('components'))
    }
  }

  return dirs
}
