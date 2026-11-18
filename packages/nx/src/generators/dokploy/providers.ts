// The OpenTofu providers of the dokploy generator: the constraint that
// versions.tf writes and the lock block that .terraform.lock.hcl gets. The
// typecheck target of @zukhruf/nx/opentofu reads the lock file and never
// writes it (-lockfile=readonly), so the generator writes the lock with the
// hashes of linux_amd64 (CI) and darwin_arm64 (a Mac), from
// `tofu providers lock -platform=linux_amd64 -platform=darwin_arm64` on
// 2026-11-18. An update of a provider changes both here.

export interface Provider {
  /** The local name in required_providers, for example `dokploy`. */
  name: string;
  /** The source address in required_providers. */
  source: string;
  /** The version constraint in required_providers. */
  version: string;
  /** The block of the provider in .terraform.lock.hcl. */
  lock: string;
}

export const dokployProvider: Provider = {
  name: 'dokploy',
  source: 'registry.terraform.io/ahmedali6/dokploy',
  version: '~> 0.8',
  lock: `provider "registry.terraform.io/ahmedali6/dokploy" {
  version     = "0.8.0"
  constraints = "~> 0.8"
  hashes = [
    "h1:9GCMnYbi6thQrZ69TNeG75qR2zRq3S+MAkBjSI698/o=",
    "h1:VhsCvKgEmO+Q/E3RV6mz7yWiSTsxMNe+qjmXdnQRTmo=",
    "zh:2c221ad81b20b131d0f7231b500665db5d37b5d83cdd1ea0228fef2b2a3b0114",
    "zh:37fae35c05226aa30b01c6b167255b33bfb269872f7a7a65e059f18cefc5861e",
    "zh:4795c015ec6a13d4fac99783451cf2390c4ecf4c98ba2349e79a1e77d5147c4f",
    "zh:67cc147f07ed5d4e3e2ba1c182e8f2248c76111574da747e0cd673e02409f03d",
    "zh:7278ad86d2d40e9dfd827abdfe13b7715f5e676c681012a3b9d5a84bad2152b4",
    "zh:8102560604d7e5ac079df04bd834df692260af659964a6a1fad260cee1e70c4e",
    "zh:890df766e9b839623b1f0437355032a3c006226a6c200cd911e15ee1a9014e9f",
    "zh:a203075eafd2385bf737f4787c28ace6eedf8197b045b2fa9548117515a3ce7e",
    "zh:aa7b6e9421ded6d8d0beacc508da3b28d27d9fb1f9b61a72da235bac21a1a901",
    "zh:b140d15cdadf555009b2488f531cdf69892e85b5ec626dca6a04a3ed3bcebe8c",
    "zh:b67feeb316a4246651de81c433a20a517d35ac1f628fef1ccbf28a7377f45b05",
    "zh:bdbd8f32e4b04150415540d1cdd17863644c1a95080972cfdb12755debe12384",
    "zh:d276a41b2f82a0d45624d295765cd39ffa280fb5466261f547e2a2ea472bbfcb",
    "zh:dc7dc41537917821df7d3fe020416bd867326ed53cf9b25734a65fb99f128eb9",
  ]
}`,
};

export const hcloudProvider: Provider = {
  name: 'hcloud',
  source: 'hetznercloud/hcloud',
  version: '~> 1.66.0',
  lock: `provider "registry.opentofu.org/hetznercloud/hcloud" {
  version     = "1.66.1"
  constraints = "~> 1.66.0"
  hashes = [
    "h1:2xnL6r7iH/7sheeBlcSC8KpT9kUSYiboo0Ujc7B0RLw=",
    "h1:4umCzzfMlXTswvnn46dX0tPNl267O72eIXRkO/+Nfng=",
    "h1:7CSl5SdPjP2VK96O/4rz4zem2WSljipRr2r2DQWDbRw=",
    "h1:JO2NGqSohoL+EfmcuUC6LdvoZh8Qd4fl0+Fqfyz+3Oc=",
    "h1:QHgbvrPciaSf3B9q4tdfPq4yK5sJpA0vq7Z5Mjfj/sg=",
    "h1:R+S77AiRWQQnVROR+HNqMXnhX8fDxZVBG1PwlpxGyss=",
    "h1:WU+1RcBhDQNRY5CcurLApBjj8o2SOXKhJCjObIX4Ic0=",
    "h1:WztH73MMX1CpUuglqMmnugXLS20nMHsntteg1hcM2xQ=",
    "h1:Z/ipcn9gDF25Sjbp0v80Alt/6v4XwiBBmd9V6mYo0I0=",
    "h1:bKv1qR7TB/x6a1u1OmacaGgFXmkAukokAPizicGvHAo=",
    "h1:cc0E0i8geVFX5z8Kt5qrRew3eyB1OaWxTBzBbkoU7tA=",
    "h1:lTWPM6oRkJ7988uDQ2bR8SUeezk7ux/rwg3WIuN2oRU=",
    "h1:rxfnUOt0pPl2XXqIzMaEJimpWjBquLOCHv5Z/4/AD6g=",
    "zh:113070176eb4fb26a3758b3d1031bb904e34a74f7c4f99f90df2301ca4468a51",
    "zh:1bfc988bdcd7c9422e09c262c736ad265a205684f0402fa4a83e63c0b08e09ea",
    "zh:37d92b4cf0f344295b0d780aabbc1408f02db31141cd4408276455a458071e54",
    "zh:386bd1207b3ed284b513294ddad9b9f59047a693c3aa375605f858f9d9758b58",
    "zh:43d26f0a4f5a64bf0ade1c5a278b40153d4ae8c77508933b9c8bb7f7860dae6d",
    "zh:6a1fe681a1706be87f0d03b749f1dc69c838d663c6ab08a00ae8d87be2e4425e",
    "zh:7032556ae2a74b2e1b7d68add9b96158e4f7202ebb8fbd75e0e8a1581719df7b",
    "zh:893296927373b4afa7ec3639abb1ebab3c1b6cb9cfe427877cfa7bf69a33480d",
    "zh:8d58b340e21428a59cc27dc4f5a7fcd2035ee1aa9372c3932f7962647532fe0d",
    "zh:93509170347bf097ca38e288a6e921811bb769bb2dfac3c339eb2032ae8454c1",
    "zh:9c00443cb5ae2401089a62e223d7d741eedb04f6a73c357b6a7443b6ae71b0be",
    "zh:9c356be5ce8cb7b1d83d5cf2276823242f106dbd0c43fe992055f0fa11290f95",
    "zh:f619116583c7e47751e0baefffca216c83f9f42edf99325121b85ee075db78cc",
  ]
}`,
};

/** The postgres password comes from random_password. */
export const randomProvider: Provider = {
  name: 'random',
  source: 'hashicorp/random',
  version: '~> 3.6',
  lock: `provider "registry.opentofu.org/hashicorp/random" {
  version     = "3.9.1"
  constraints = "~> 3.6"
  hashes = [
    "h1:38E2VQmQDhws/3AL3D/EzBGuCseepyZRIswAOx8CqoQ=",
    "h1:7+qv9kpOpBC9EUPCubnPxh603tu3l9EIMMBkpbt1H1Y=",
    "h1:CEQeHfnUDB3uqAkKoEWfWgbj+kpoQHgcuPbAjPzbh+U=",
    "h1:HPYO9tf8KUSHqSdz1uOL97MLeaVHPaWPY1JW6tKU19E=",
    "h1:KYXiC06Pr3WJcIUbDq9MgdAbInO5zcRyHFqV1x5UcJg=",
    "h1:MygjbYH8CrPv8RUe75tZAFmrFNIzQLT45fiyYx7u2tI=",
    "h1:RMSARNOw4qZx+VmHYnVMGljsFVfCV1P+nJjKrN2XIOI=",
    "h1:U/71jbSbfsfVLxWpSlhyVHh/DnQXQhjoJCGkyongkBA=",
    "h1:WwLLvRE1q95CTGxyTjKpctXJ0ooVs9d22JAQS9fC3uo=",
    "h1:ZtRBSqoyfQAhngjUjM0NRPtj6NdSJ/JBENFwT8D276s=",
    "h1:cfxedZLduhHD1UtqQDjAQZNAEhr/bWDAZ4nU9rSdySg=",
    "h1:i45mo4de0QKOreStMqUQ7qyZL3ucFq42l178Fm5/hMU=",
    "h1:v3SAJKN4D3dOM95xKwgKGIWELe5nUBbyXdb5HNz7icw=",
    "h1:v3vTk/STekrzNc6NG3jL9/05zhvF1QVCgyRRbvSHPcI=",
    "h1:zHgFWtRBgOycqhw8HdLSvMVNWGJtIjOAPYOcAdE7cL0=",
    "zh:09aaf19b0d22726d2378e0e89fbbefc183494d7bd585759d6c4e69ba50951a2f",
    "zh:31575ca9bc0db20337096d178ea73bce3ebca343ed071c67f78cf39f800c9ec6",
    "zh:624fb6ed552abc34a5aaac41e76a373da65ac08e524b09b672f29c60e6ac896a",
    "zh:6a4760d55132b9750ac1a04f6fc32e247034daa999f71452dba9cbca225a529a",
    "zh:768a6047cfb8958e7b0b120c580aa3de6624a7fbb2c56ad6df85cd559ed26ec7",
    "zh:8983c788ba660bcb587e64ff9c3e4323515caf78facbe0abe6432e7aff8df893",
    "zh:8d570eb026a4f00b58a1d36be0ce3c13adf4d973efcd4162b05cb295bbc14257",
    "zh:a2259540854d5f699c36b89244fb202ebb2c219b64669a51072687d04fb47152",
    "zh:aaa51d905b0e80a28e02f9bee2cf6c91ffade7389d77ab9198aa12809ed04955",
    "zh:afb60995e98573facddfb47baedf7e288408680eb00b5d3df570611758947c72",
    "zh:b9a46d852ce53fa037f47537a7de53f37b759ccf211600b7ba44c66ba4b616b7",
    "zh:bafcfeeefcd0dfefeff120b655b45edb0497c4717534ffe5201b3cb556d1ffe6",
    "zh:c3ac24d397eae054aca2290e20943e0c767592cc661c890850c25ac01829308d",
    "zh:eafba4127ebadcc5ed0e427935c66fb5e2da7cfdaae39a66d52f4a50d51faf1e",
    "zh:f39d4bce213ed9bba3474bad468136af08ff6c4c33adaafcc10c1f78067adfe3",
  ]
}`,
};
