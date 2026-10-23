# TEMPLATE (alternative to shell.nix): a flake whose flake.lock pins the binaries a verification tool needs.
# Keep flake.nix and flake.lock committed next to the tool script.
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/<nixpkgs-branch-or-commit>";
  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      each = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      # EXAMPLE packages: list only what the tool script calls.
      devShells = each (pkgs: { default = pkgs.mkShell { packages = [ pkgs.bash pkgs.curl pkgs.jq ]; }; });
    };
}
