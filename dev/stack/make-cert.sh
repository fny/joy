#!/usr/bin/env bash
# Generate a local CA and agent-01 certificate with existing OpenSSL tooling.
set -euo pipefail
umask 077
dest=${1:?Usage: make-cert.sh PRIVATE_CERT_DIRECTORY}
mkdir -p "$dest"
for name in ca.key ca.crt server.key server.crt; do
  if [[ -e "$dest/$name" ]]; then
    echo "Refusing to overwrite $dest/$name" >&2
    exit 1
  fi
done
openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 365 \
  -keyout "$dest/ca.key" -out "$dest/ca.crt" \
  -subj '/CN=Joy local development CA' \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign'
openssl req -new -newkey rsa:2048 -nodes \
  -keyout "$dest/server.key" -out "$dest/server.csr" -subj '/CN=agent-01'
cat > "$dest/server.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:agent-01,DNS:localhost,IP:127.0.0.1,IP:100.121.220.10
EOF
if [[ -n "${JOY_TEST_VM_IP:-}" ]]; then
  # OpenSSL validates the address when it reads this extension.
  sed -i "s/^subjectAltName=.*/&,IP:$JOY_TEST_VM_IP/" "$dest/server.ext"
fi
openssl x509 -req -in "$dest/server.csr" -CA "$dest/ca.crt" \
  -CAkey "$dest/ca.key" -CAcreateserial -out "$dest/server.crt" \
  -days 90 -sha256 -extfile "$dest/server.ext"
chmod 644 "$dest/ca.crt" "$dest/server.crt"
openssl verify -CAfile "$dest/ca.crt" -verify_hostname agent-01 "$dest/server.crt"
echo "Trust $dest/ca.crt on the client; keep both .key files private."
