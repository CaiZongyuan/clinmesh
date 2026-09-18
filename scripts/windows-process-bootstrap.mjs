import spawn from 'cross-spawn'

const input = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8'))
if (!input || typeof input.command !== 'string' || !Array.isArray(input.args)
  || !input.args.every(argument => typeof argument === 'string')) {
  throw new Error('Invalid Windows development command')
}
const child = spawn(input.command, input.args, { stdio: 'inherit', windowsHide: true })
child.once('error', error => {
  console.error(`${input.command}: ${error.message}`)
  process.exitCode = 1
})
child.once('exit', code => { process.exitCode = code ?? 1 })
