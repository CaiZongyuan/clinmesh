import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import {
  createLanDevelopmentPlan,
  findPrivateIpv4Addresses,
  resolveLanAddresses,
} from './dev-lan.ts'

function networkAddress(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    cidr: `${address}/24`,
    family: 'IPv4',
    internal,
    mac: '00:00:00:00:00:00',
    netmask: '255.255.255.0',
  }
}

describe('findPrivateIpv4Addresses', () => {
  it('returns private LAN addresses without loopback or public interfaces', () => {
    expect(findPrivateIpv4Addresses({
      docker0: [networkAddress('172.17.0.1')],
      ethernet: [networkAddress('192.168.1.23'), networkAddress('203.0.113.8')],
      loopback: [networkAddress('127.0.0.1', true)],
      wifi: [networkAddress('10.0.0.7')],
    })).toEqual(['10.0.0.7', '172.17.0.1', '192.168.1.23'])
  })
})

describe('createLanDevelopmentPlan', () => {
  it('creates one Server and Web process with trusted LAN origins', () => {
    expect(createLanDevelopmentPlan(['192.168.1.23'])).toEqual({
      origins: [
        'http://127.0.0.1:51868',
        'http://127.0.0.1:51888',
        'http://192.168.1.23:51888',
      ],
      processes: [
        {
          args: ['dev:server'],
          environment: {
            CLINMESH_TRUSTED_ORIGINS: 'http://127.0.0.1:51868,http://127.0.0.1:51888,http://192.168.1.23:51888',
          },
          name: 'Server',
        },
        {
          args: ['dev:web', '--', '--host', '0.0.0.0'],
          environment: {},
          name: 'Web',
        },
      ],
      urls: ['http://192.168.1.23:51888/'],
    })
  })

  it('requires a private IPv4 address', () => {
    expect(() => createLanDevelopmentPlan([])).toThrow('CLINMESH_LAN_IP')
  })
})

describe('resolveLanAddresses', () => {
  it('skips interface detection when an explicit address is provided', () => {
    const detectAddresses = vi.fn(() => {
      throw new Error('interface detection failed')
    })

    expect(resolveLanAddresses('192.168.50.4', detectAddresses)).toEqual(['192.168.50.4'])
    expect(detectAddresses).not.toHaveBeenCalled()
  })

  it('rejects an explicit public address', () => {
    expect(() => resolveLanAddresses('203.0.113.8')).toThrow('private IPv4')
  })
})
