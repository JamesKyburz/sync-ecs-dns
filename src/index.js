const AWS = require('aws-sdk')
const get = require('lodash.get')
const run = require('run-duck-run')

exports.sync = (event, context, callback) => {
  run(
    function * () {
      const { group, clusterArn: cluster } = get(event, 'detail', {})
      if (!group || !cluster) return

      const ecs = new AWS.ECS()
      const route53 = new AWS.Route53()

      const zoneId = get(
        yield cb =>
          route53.listHostedZonesByName(
            {
              DNSName: process.env.DNS_SUFFIX
            },
            cb
          ),
        'HostedZones[0].Id'
      )

      const runningIps = []
      const allTasks = (yield cb => ecs.listTasks({ cluster }, cb)).taskArns

      while (allTasks.length) {
        const taskArns = allTasks.splice(0, 100)
        const resources = yield cb =>
          ecs.describeTasks({ cluster, tasks: taskArns }, cb)
        runningIps.push(
          ...get(resources, 'tasks', [])
            .filter(x => x.group === group && x.desiredStatus === 'RUNNING')
            .map(x => ({
              Value: get(
                x,
                'containers[0].networkInterfaces[0].privateIpv4Address'
              )
            }))
            .filter(x => x.Value)
        )
      }

      const dnsName = `${group.split(':')[1]}.${process.env.DNS_SUFFIX}.`

      const resources = yield cb =>
        route53.listResourceRecordSets(
          {
            HostedZoneId: zoneId,
            StartRecordType: 'A',
            StartRecordName: dnsName,
            MaxItems: '1'
          },
          cb
        )

      const currentRecordSet = get(resources, 'ResourceRecordSets[0]')

      const route53Changes = [
        currentRecordSet && {
          Action: 'DELETE',
          ResourceRecordSet: currentRecordSet
        },
        runningIps.length && {
          Action: 'CREATE',
          ResourceRecordSet: {
            Name: dnsName,
            ResourceRecords: runningIps,
            TTL: 15,
            Type: 'A'
          }
        }
      ].filter(x => x && x.ResourceRecordSet.Name === dnsName)

      if (!route53Changes.length) return

      if (
        route53Changes.length === 2 &&
        route53Changes[0].ResourceRecordSet.ResourceRecords.map(
          x => x.Value
        ).toString() ===
          route53Changes[1].ResourceRecordSet.ResourceRecords.map(
            x => x.Value
          ).toString()
      ) {
        return
      }

      console.log(
        JSON.stringify({
          event,
          route53Changes
        })
      )

      yield cb =>
        route53.changeResourceRecordSets(
          {
            HostedZoneId: zoneId,
            ChangeBatch: {
              Changes: route53Changes
            }
          },
          cb
        )
    },
    err => {
      if (err) console.log(JSON.stringify({ err, event }))
      callback()
    }
  )()
}
