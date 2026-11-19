Test PKI for test/headscale.test.ts (throwaway, not secret): root → intermediate → leaves for
`studio.mesh.corp.example`. `node` is valid for 397 days, `long` for 900 days, `client` has
only clientAuth usage, `misordered.crt` puts the intermediate first. Tests pass a fixed `now`
inside the validity window. Generated with openssl on 2026-11-18.
