define(function(require){
    const ajax = require('p4/io/ajax'),
        dsv = require('p4/io/parser'),
        dataStruct = require('p4/core/datastruct'),
        pipeline = require('p4/core/pipeline'),
        join = require('p4/dataopt/join'),
        arrays = require('p4/core/arrays'),
        aggregate = require('p4/dataopt/aggregate'),
        cstore = require('p4/cquery/cstore');

    const TERMINAL_METRICS = ["lp_id", "terminal_id", "data_size", "avg_packet_latency", "packets_finished", "avg_hops", "sat_time"];
    const LINK_METRICS = ["group_id", "router_id", "router_port", "sat_time", "traffic"];

    return function(args, callback) {
        const DATASET = '/data/' + args.path,
            TERMINAL_PER_ROUTER = args.terminals / args.routers;
            ROUTER_PER_GROUP = args.routers / args.groups,
            LOCAL_LINK_COUNT = args.localLinkPerRouter || ROUTER_PER_GROUP,
            GLOBAL_LINK_COUNT = args.globalLinkPerRouter || TERMINAL_PER_ROUTER,
            GROUP_TOTAL = TERMINAL_PER_ROUTER * ROUTER_PER_GROUP + 1,
            ROUTER_TOTAL = ROUTER_PER_GROUP * GROUP_TOTAL;

        function calcTargetRouter(group_id, router_id, port) {
            var first = router_id % ROUTER_TOTAL;
            var target_grp = first + port * ROUTER_PER_GROUP;
            if(target_grp == group_id) {
                target_grp = GROUP_TOTAL - 1;
            }
            var my_pos = group_id % ROUTER_PER_GROUP;
            if(group_id == GROUP_TOTAL - 1) {
                my_pos = target_grp % ROUTER_PER_GROUP;
            }
            var target_pos =  target_grp * ROUTER_PER_GROUP + my_pos;
            return target_pos;
        }

        var datafiles = [
                {url: DATASET + "/dragonfly-msg-stats", dataType: "text"},
                {url: DATASET + "/dragonfly-router-stats", dataType: "text"},
                {url: DATASET + "/dragonfly-router-traffic", dataType: "text"}
            ];

        if(args.hasOwnProperty('jobAllocation'))
            datafiles.push({url: DATASET + '/' +args.jobAllocation,dataType: "text"});

        ajax.getAll(datafiles).then(function(text){

            var terminals = dataStruct({
                array: dsv(text[0], " "),
                header: TERMINAL_METRICS,
                types: ["int", "int", "int", "float", "float", "float", "float"],
                skip: 1
            }).objectArray();

            if(text.length > 3 && text[3].length) {
                var jobs = text[3].split("\n").map(function(j){return j.split(" ")});
                jobs.pop();

                terminals.forEach(function(terminal){
                    terminal.job_id = 'none';
                })

                jobs.forEach(function(job, jobId){
                    job.forEach(function(nodeId){
                        var nid = parseInt(nodeId);
                        if(nid >= 0)
                            terminals[nid].job_id = jobId;
                    })

                });
            }

            var busytime = dataStruct({
                array: dsv(text[1], " "),
                header: ["lp_id", "group_id", "router_id", "local_sat_time", "global_sat_time"],
                types: ["int", "int", "int", "veci"+LOCAL_LINK_COUNT, "veci"+GLOBAL_LINK_COUNT],
                skip: 2,
            }).objectArray();

            var traffic = dataStruct({
                array: dsv(text[2], " "),
                header: ["lp_id", "group_id", "router_id", "local_traffic", "global_traffic"],
                types: ["int", "int", "int", "veci"+LOCAL_LINK_COUNT, "veci"+GLOBAL_LINK_COUNT],
                skip: 2,
            }).objectArray();

            var localLinks = [],
                globalLinks = [];

            busytime.forEach(function(l, li){
                l.local_sat_time.forEach(function(b, bi){
                    var link = {};
                    link.group_id = l.group_id;
                    link.router_rank = l.router_id;
                    link.router_id = l.group_id * ROUTER_PER_GROUP + l.router_id;
                    link.router_port = bi;
                    link.sat_time = b;
                    link.traffic = traffic[li].local_traffic[bi];
                    link.target_router = l.group_id * ROUTER_PER_GROUP + bi;
                    localLinks.push(link);
                });

                l.global_sat_time.forEach(function(g, gi){
                    var link = {};
                    link.group_id = l.group_id;
                    link.router_rank = l.router_id;
                    link.router_id = l.group_id * ROUTER_PER_GROUP + l.router_id;
                    link.router_port = gi;
                    link.sat_time = g;
                    link.traffic = traffic[li].global_traffic[gi];
                    link.target_router = calcTargetRouter(link.group_id, link.router_rank, link.router_port);
                    globalLinks.push(link);
                });
            })

            terminals = pipeline()
                .derive(function(d) {
                    d.router_id = Math.floor(d.terminal_id/TERMINAL_PER_ROUTER);
                    d.router_rank = Math.floor(d.router_id/ROUTER_PER_GROUP);
                    d.router_port = d.terminal_id % TERMINAL_PER_ROUTER;
                    d.group_id = Math.floor(d.terminal_id/TERMINAL_PER_ROUTER/ROUTER_PER_GROUP);
                })
                .aggregate({
                    $group: 'router_id',
                    terminals: {$data: '*'},
                })
                .execute(terminals);

            localLinks = pipeline().aggregate({
                $group: 'router_id',
                router_rank: {$first: 'router_rank'},
                group_id: {$first: 'group_id'},
                local_links: {$data: '*'}
            })
            .execute(localLinks);

            globalLinks = pipeline().aggregate({
                $group: 'router_id',
                router_rank: {$first: 'router_rank'},
                group_id: {$first: 'group_id'},
                global_links: {$data: '*'}
            })
            .execute(globalLinks);

            var routers = join(terminals, localLinks);
            routers = join(routers, globalLinks);

            routers.forEach(function(router, ri){
                router.local_traffic = arrays.sum(router.local_links.map((d)=>(d.traffic)));
                router.global_traffic = arrays.sum(router.global_links.map((d)=>(d.traffic)));
                router.terminal_traffic = arrays.sum(router.terminals.map((d)=>(d.data_size)));
                router.job_id = router.terminals[0].job_id;
            })

            console.log(routers);
            callback(routers);
        })
    }
})
