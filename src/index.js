const AWS = require('aws-sdk')
const get = require('lodash.get')

exports.sync = async event => {
  try {
    const { group, clusterArn: cluster } = get(event, 'detail', {})
    if (!group || !cluster) return

    const ecs = new AWS.ECS()
    const route53 = new AWS.Route53()

    const zoneId = get(
      await route53
        .listHostedZonesByName({ DNSName: process.env.DNS_SUFFIX })
        .promise(),
      'HostedZones[0].Id'
    )

    const runningIps = []
    const { taskArns: allTasks } = await ecs.listTasks({ cluster }).promise()

    while (allTasks.length) {
      const taskArns = allTasks.splice(0, 100)
      const resources = await ecs
        .describeTasks({ cluster, tasks: taskArns })
        .promise()
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

    const resources = await route53
      .listResourceRecordSets({
        HostedZoneId: zoneId,
        StartRecordType: 'A',
        StartRecordName: dnsName,
        MaxItems: '1'
      })
      .promise()

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

    await route53
      .changeResourceRecordSets({
        HostedZoneId: zoneId,
        ChangeBatch: {
          Changes: route53Changes
        }
      })
      .promise()
  } catch (err) {
    console.error(JSON.stringify({ err, event }))
  }
}
