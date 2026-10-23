# TEMPLATE: pins the binaries a nix verification tool needs. Copy it next to the tool script.
# Pin nixpkgs to one commit so every machine gets the same versions: replace <nixpkgs-commit> and <sha256>
# (nix-prefetch-url --unpack https://github.com/NixOS/nixpkgs/archive/<nixpkgs-commit>.tar.gz prints the hash).
let
  pkgs = import (fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/<nixpkgs-commit>.tar.gz";
    sha256 = "<sha256>";
  }) { };
in
pkgs.mkShell {
  # EXAMPLE packages: list only what the tool script calls.
  packages = [ pkgs.bash pkgs.curl pkgs.jq ];
}
