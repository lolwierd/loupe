# https and the short host

loupe answers on `http://loupe.local`. Two optional extras need one-time steps on your machine; nothing here runs by
itself, and loupe never touches your keychain, `/etc/hosts` or a CA.

## The short host: `l.local`

The daemon publishes `l.local` the same way it publishes `loupe.local` (a second `dns-sd -P` record while it runs), so it
needs no password and no setup. Take a GitHub pull request link and swap `github.com` for `l.local`:

    https://github.com/acme/widgets/pull/123
    http://l.local/acme/widgets/pull/123

`l.local` serves nothing itself. Every GET or HEAD is redirected to the same path on `loupe.local` (a pull request link
then opens through the page, as a `loupe.local` link does); any other method gets a 405.

It takes effect when the daemon restarts: `loupe service restart` (or stop and start `loupe serve`). If the name does not
resolve right after, `dns-sd` needs a few seconds to announce it; `ping -c1 l.local` should answer from 127.0.0.1.

`l.local` is published only by the daemon named `loupe`; a second instance started with `LOUPE_NAME` does not publish it,
so two daemons never fight over the name.

## https for `loupe.local` and `l.local`

If `~/.loupe/tls/cert.pem` and `~/.loupe/tls/key.pem` exist when the daemon starts, it also listens on port 443 for
`loupe.local` and `l.local` (the same way it takes port 80: macOS lets a normal user bind it on the wildcard address, and
the listener drops every connection that is not from this machine). With no files there, nothing changes. `--no-80` turns
off 443 as well as 80. The daemon then hands out `https://loupe.local` as its address (the CLI opens it, the page shows it);
`http://loupe.local` keeps working.

`./install.sh` asks whether to set this up and runs the steps below for you (`./install.sh --https` does it without
asking, `--no-https` skips the question); a certificate already in `~/.loupe/tls` is left as it is.

The certificate has to be one your browser trusts, and it has to name both hosts. [mkcert](https://github.com/FiloSottile/mkcert)
makes a private CA on your machine and a certificate from it. The steps, once:

    brew install mkcert
    mkcert -install
    mkdir -p ~/.loupe/tls
    mkcert -cert-file ~/.loupe/tls/cert.pem -key-file ~/.loupe/tls/key.pem loupe.local l.local
    loupe service restart

`mkcert -install` is the one that asks for your password: it adds mkcert's root certificate to the macOS system keychain
(and to Firefox's store if Firefox is installed). It is the only step that trusts anything, and `mkcert -uninstall`
removes it.
The root key stays in the folder `mkcert -CAROOT` prints; keep it private, because anyone holding it can mint certificates
your browser trusts.

To check it: `curl -s -o /dev/null -w '%{http_code}\n' https://loupe.local/api/state` should print 200 with no certificate
warning, and `curl -sI https://l.local/anything` should answer 302 with `Location: https://loupe.local/anything`. (Use
GET for the first: the daemon's routes answer GET, so `curl -I`, which sends HEAD, gets a 404 there. `l.local` answers HEAD.)

The certificate is read when the daemon starts. mkcert certificates last a little over two years; renew one by running
the `mkcert -cert-file ...` line again and restarting.

## Settings you can set in the environment

| variable | what it does |
| --- | --- |
| `LOUPE_TLS_PORT` | the https port (default 443); setting it also overrides `--no-80`, for trying this without a privileged port |
