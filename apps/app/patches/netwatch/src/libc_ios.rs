//! ESTIA: le costanti di <net/route.h> che `libc` >= 0.2.190 dichiara per
//! macOS e non per iOS, dove il kernel (XNU) è lo stesso. Copiate da libc
//! 0.2.191 (`src/unix/bsd/mod.rs` e `src/unix/bsd/apple/mod.rs`). Il resto
//! viene da `libc` com'è. Vedi apps/app/patches/README.md.
#![allow(dead_code)]

pub use ::libc::*;


pub const RTF_UP: ::libc::c_int = 0x1;
pub const RTF_GATEWAY: ::libc::c_int = 0x2;
pub const RTF_HOST: ::libc::c_int = 0x4;
pub const RTF_REJECT: ::libc::c_int = 0x8;
pub const RTF_DYNAMIC: ::libc::c_int = 0x10;
pub const RTF_MODIFIED: ::libc::c_int = 0x20;
pub const RTF_DONE: ::libc::c_int = 0x40;
pub const RTF_STATIC: ::libc::c_int = 0x800;
pub const RTF_BLACKHOLE: ::libc::c_int = 0x1000;
pub const RTF_PROTO2: ::libc::c_int = 0x4000;
pub const RTF_PROTO1: ::libc::c_int = 0x8000;
pub const RTM_ADD: ::libc::c_int = 0x1;
pub const RTM_DELETE: ::libc::c_int = 0x2;
pub const RTM_CHANGE: ::libc::c_int = 0x3;
pub const RTM_GET: ::libc::c_int = 0x4;
pub const RTM_LOSING: ::libc::c_int = 0x5;
pub const RTM_REDIRECT: ::libc::c_int = 0x6;
pub const RTM_MISS: ::libc::c_int = 0x7;
pub const RTA_DST: ::libc::c_int = 0x1;
pub const RTA_GATEWAY: ::libc::c_int = 0x2;
pub const RTA_NETMASK: ::libc::c_int = 0x4;
pub const RTA_GENMASK: ::libc::c_int = 0x8;
pub const RTA_IFP: ::libc::c_int = 0x10;
pub const RTA_IFA: ::libc::c_int = 0x20;
pub const RTA_AUTHOR: ::libc::c_int = 0x40;
pub const RTA_BRD: ::libc::c_int = 0x80;
pub const RTAX_DST: ::libc::c_int = 0;
pub const RTAX_GATEWAY: ::libc::c_int = 1;
pub const RTAX_NETMASK: ::libc::c_int = 2;
pub const RTAX_GENMASK: ::libc::c_int = 3;
pub const RTAX_IFP: ::libc::c_int = 4;
pub const RTAX_IFA: ::libc::c_int = 5;
pub const RTAX_AUTHOR: ::libc::c_int = 6;
pub const RTAX_BRD: ::libc::c_int = 7;
pub const RTF_DELCLONE: ::libc::c_int = 0x80;
pub const RTF_CLONING: ::libc::c_int = 0x100;
pub const RTF_XRESOLVE: ::libc::c_int = 0x200;
pub const RTF_LLINFO: ::libc::c_int = 0x400;
pub const RTF_NOIFREF: ::libc::c_int = 0x2000;
pub const RTF_PRCLONING: ::libc::c_int = 0x10000;
pub const RTF_WASCLONED: ::libc::c_int = 0x20000;
pub const RTF_PROTO3: ::libc::c_int = 0x40000;
pub const RTF_PINNED: ::libc::c_int = 0x100000;
pub const RTF_LOCAL: ::libc::c_int = 0x200000;
pub const RTF_BROADCAST: ::libc::c_int = 0x400000;
pub const RTF_MULTICAST: ::libc::c_int = 0x800000;
pub const RTF_IFSCOPE: ::libc::c_int = 0x1000000;
pub const RTF_CONDEMNED: ::libc::c_int = 0x2000000;
pub const RTF_IFREF: ::libc::c_int = 0x4000000;
pub const RTF_PROXY: ::libc::c_int = 0x8000000;
pub const RTF_ROUTER: ::libc::c_int = 0x10000000;
pub const RTF_DEAD: ::libc::c_int = 0x20000000;
pub const RTF_GLOBAL: ::libc::c_int = 0x40000000;
pub const RTM_VERSION: ::libc::c_int = 5;
pub const RTM_LOCK: ::libc::c_int = 0x8;
pub const RTM_OLDADD: ::libc::c_int = 0x9;
pub const RTM_OLDDEL: ::libc::c_int = 0xa;
pub const RTM_RESOLVE: ::libc::c_int = 0xb;
pub const RTM_NEWADDR: ::libc::c_int = 0xc;
pub const RTM_DELADDR: ::libc::c_int = 0xd;
pub const RTM_IFINFO: ::libc::c_int = 0xe;
pub const RTM_NEWMADDR: ::libc::c_int = 0xf;
pub const RTM_DELMADDR: ::libc::c_int = 0x10;
pub const RTM_IFINFO2: ::libc::c_int = 0x12;
pub const RTM_NEWMADDR2: ::libc::c_int = 0x13;
pub const RTM_GET2: ::libc::c_int = 0x14;
pub const RTV_MTU: ::libc::c_int = 0x1;
pub const RTV_HOPCOUNT: ::libc::c_int = 0x2;
pub const RTV_EXPIRE: ::libc::c_int = 0x4;
pub const RTV_RPIPE: ::libc::c_int = 0x8;
pub const RTV_SPIPE: ::libc::c_int = 0x10;
pub const RTV_SSTHRESH: ::libc::c_int = 0x20;
pub const RTV_RTT: ::libc::c_int = 0x40;
pub const RTV_RTTVAR: ::libc::c_int = 0x80;
pub const RTAX_MAX: ::libc::c_int = 8;
