import esbuild from 'esbuild';
import builtinModules from 'builtin-modules';

const plugins = [];
const external = ['obsidian', ...builtinModules];

const isDev = process.argv.includes('--dev');
const isProd = process.argv.includes('--minify');

const config = {
    entryPoints: [
        'src/main.ts'
    ],
    bundle: true,
    external,
    plugins,
    outfile: 'dist/main.js',
    platform: 'node',
    sourcemap: isDev ? 'inline' : false,
    minify: isProd,
};

async function main() {
    if (isDev) {
        const ctx = await esbuild.context(config);
        await ctx.watch();
    } else {
        await esbuild.build(config);
    }
}

main();
