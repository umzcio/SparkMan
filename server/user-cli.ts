/**
 * Manage console accounts:
 *   pnpm user:set <name>      create or reset a password (prompted, not echoed)
 *   pnpm user:remove <name>   delete an account (its sessions stop working)
 *   pnpm user:list
 * Writes SPARKMAN_USERS_FILE (default /etc/sparkman/users.json); restart not needed.
 */
import { readUsers, writeUser } from './auth.ts'

const file = process.env.SPARKMAN_USERS_FILE ?? '/etc/sparkman/users.json'
const [cmd, name] = process.argv.slice(2)

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin
    process.stdout.write(question)
    if (!stdin.isTTY) {
      let buf = ''
      stdin.setEncoding('utf8')
      stdin.on('data', (d) => (buf += d))
      stdin.on('end', () => resolve(buf.split('\n')[0]))
      return
    }
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let value = ''
    const onData = (ch: string) => {
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode(false)
        stdin.pause()
        stdin.off('data', onData)
        process.stdout.write('\n')
        resolve(value)
      } else if (ch === '\u0003') {
        process.exit(130)
      } else if (ch === '\u007f') {
        value = value.slice(0, -1)
      } else {
        value += ch
      }
    }
    stdin.on('data', onData)
  })
}

async function main() {
  if (cmd === 'list') {
    console.log(Object.keys(readUsers(file)).join('\n') || '(no users)')
    return
  }
  if (!name || !/^[a-z0-9._@+-]{1,128}$/i.test(name) || (cmd !== 'set' && cmd !== 'remove')) {
    console.error('usage: user-cli set|remove <name>   |   user-cli list')
    process.exit(2)
  }
  if (cmd === 'remove') {
    writeUser(file, name, null)
    console.log(`removed ${name}`)
    return
  }
  const pw = await prompt(`New password for ${name}: `)
  if (pw.length < 12) {
    console.error('Use at least 12 characters.')
    process.exit(1)
  }
  if (process.stdin.isTTY && (await prompt('Again: ')) !== pw) {
    console.error("Passwords don't match.")
    process.exit(1)
  }
  writeUser(file, name, pw)
  console.log(`saved ${name} in ${file}`)
}

void main()
