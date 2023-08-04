const util = require('node:util');
const fs = require('fs');
const exec = util.promisify(require('node:child_process').exec);

const accountStore = require('./accounts.json');

const clustersPerAccount = 90;
const clusterPrefix = "argotesting";
const re = new RegExp(clusterPrefix+"([0-9]{1,4})");

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getParameters(paramName) {
  const index = process.argv.indexOf("--"+paramName);
  let value;

  if(index > -1) {
    value = process.argv[index+1];
    return value;
  } else {
    return false;
  }
}

function getAcctFromClusterNum(clusterNum) {
  let acctNum = Math.ceil(clusterNum / clustersPerAccount) - 1;
  if(acctNum < 0) {
    acctNum = 0;
  }
  return accountStore[acctNum];
}

async function getKubeContexts() {
  let returnArr = [];
  let contextOutput = await runCommand('kubectl config get-contexts --output=name',"","",true);
  let contextArr = contextOutput.stdout.split("\n").filter((obj)=>obj.match(re));
  for(let i in contextArr) {
    let regmatch = contextArr[i].match(re);
    returnArr[regmatch[1]] = contextArr[i];
  }
  return returnArr;
}

async function loginArgoCD() {
  let getURL = JSON.parse((await runCommand('kubectl -n argocd get svc argocd-server -o json','"loadBalancer": {}',"",true)).stdout);
  let getSecret = JSON.parse((await runCommand('kubectl get secrets -n argocd argocd-initial-admin-secret -o json', "NotFound", "", true)).stdout);
  let secretBuf = Buffer.from(getSecret.data["password"], 'base64');
  await runCommand('argocd login '+getURL.status.loadBalancer.ingress[0].hostname+' --insecure --username admin --password '+secretBuf.toString("ascii"),"", "", false);
}

async function getDashboards() {
  let getSecret = JSON.parse((await runCommand('kubectl get secrets -n argocd argocd-initial-admin-secret -o json', "NotFound", "", true)).stdout);
  let secretBuf = Buffer.from(getSecret.data["password"], 'base64');
  let getURL = JSON.parse((await runCommand('kubectl -n argocd get svc argocd-server -o json',"", "",true)).stdout);
  console.log("ArgoCD URL: https://" + getURL.status.loadBalancer.ingress[0].hostname);
  console.log("Username: admin");
  console.log("Password: "+secretBuf.toString("ascii"));

  let getGrafanaURL = JSON.parse((await runCommand('kubectl get svc prometheus-operator-grafana -n prometheus -o json',"", "",true)).stdout);
  console.log("Grafana URL: http://"+ getGrafanaURL.status.loadBalancer.ingress[0].hostname);
  console.log("Username: admin");
  
  let grafanaAdminPassword = JSON.parse((await runCommand('kubectl get secret prometheus-operator-grafana -n prometheus -o json',"", "",true)).stdout);
  let grafanaSecretBuf = Buffer.from(grafanaAdminPassword.data["admin-password"], 'base64');
  console.log("Password: "+grafanaSecretBuf.toString("ascii"));
}

async function getClusterURLs() {
  let getClusterURL = (JSON.parse((await runCommand('kubectl get secret -n argocd -o json',"", "",true)).stdout)).items;
  let clusterArr = ["https://kubernetes.default.svc"];
  for(let i in getClusterURL) {
    if(getClusterURL[i].metadata.labels?.["argocd.argoproj.io/secret-type"] === "cluster") {
      let bufServer = Buffer.from(getClusterURL[i].data.server, 'base64');
      let bufName = Buffer.from(getClusterURL[i].data.name, 'base64');
      let regmatch = bufName.toString("ascii").match(re);
      clusterArr[regmatch[1]] = bufServer.toString("ascii");
    }
  }
  return clusterArr;
}

async function getArgoApps(appName) {
  let returnArr = [];
  let argoApps = (JSON.parse((await runCommand('argocd app list -o json',"", "",true)).stdout));
  for(let i in argoApps) {
    let regex = new RegExp('cluster-([0-9]{1,4})-'+appName+'-([0-9]{1,4})');
    let regmatch = argoApps[i].metadata.name.match(regex);
    if(!returnArr[regmatch[1]]) {
      returnArr[regmatch[1]] = [];
    }
    returnArr[regmatch[1]][regmatch[2]] = argoApps[i].metadata.name;
  }
  return returnArr;
}

async function scaleNodes(numReplicas,cluster) {
  let nodeGroup = JSON.parse((await runCommand('eksctl get nodegroup --cluster '+cluster+' -o json',"","",true)).stdout)[0].Name;
  await runCommand('aws eks update-nodegroup-config --cluster-name '+cluster+' --scaling-config minSize='+numReplicas+',maxSize='+numReplicas+',desiredSize='+numReplicas+' --nodegroup-name '+nodeGroup,"ExpiredTokenException","",false);
}

async function scaleArgoController(numReplicas) {
  await runCommand('kubectl patch statefulset argocd-application-controller -n argocd -p "{\\"spec\\":{\\"template\\":{\\"spec\\":{\\"containers\\":[{\\"name\\": \\"application-controller\\", \\"env\\":[{\\"name\\":\\"ARGOCD_CONTROLLER_REPLICAS\\",\\"value\\":\\"'+numReplicas+'\\"}]}]}}}}"');
  let appServerStatefulSet = (JSON.parse((await runCommand('kubectl get statefulset -n argocd -l app.kubernetes.io/name=argocd-application-controller -o json',"","",true)).stdout)).items;
  if(appServerStatefulSet[0]) {
    if(appServerStatefulSet[0].spec.replicas !== parseInt(numReplicas)) {
      await runCommand('kubectl scale statefulsets '+appServerStatefulSet[0].spec.serviceName+' --replicas='+numReplicas+' -n argocd');
    }
  } else {
    console.log("No stateful set for argocd application set found.")
    process.exit(1);
  }
}

async function setArgoControllerShardAlgorithm(shardAlgorithm) {
  await runCommand('kubectl patch statefulset argocd-application-controller -n argocd -p "{\\"spec\\":{\\"template\\":{\\"spec\\":{\\"containers\\":[{\\"name\\": \\"application-controller\\", \\"env\\":[{\\"name\\":\\"ARGOCD_CONTROLLER_SHARDING_ALGORITHM\\",\\"value\\":\\"'+shardAlgorithm+'\\"}]}]}}}}"');
  await runCommand('kubectl rollout restart statefulset argocd-application-controller -n argocd');
}

async function scaleArgoRepoServer(numReplicas) {
  let repoServerDeployment = (JSON.parse((await runCommand('kubectl get deployments -n argocd argocd-repo-server -o json',"","",true)).stdout));
  if(repoServerDeployment) {
    if(repoServerDeployment.spec.replicas !== parseInt(numReplicas)) {
      await runCommand('kubectl scale deployment argocd-repo-server --replicas='+numReplicas+' -n argocd');
    }
  } else {
    console.log("No deployment for argocd repo deployment found.")
    process.exit(1);
  }
}

async function scaleArgoApiServer(numReplicas) {
  let apiServerDeployment = (JSON.parse((await runCommand('kubectl get deployments -n argocd argocd-server -o json',"","",true)).stdout));
  if(apiServerDeployment) {
    if(apiServerDeployment.spec.replicas !== parseInt(numReplicas)) {
      await runCommand('kubectl scale deployment argocd-server --replicas='+numReplicas+' -n argocd');
    }
  } else {
    console.log("No deployment for argocd deployment found.")
    process.exit(1);
  }
}

async function runCommand(command,failString,successString,quiet,account) {
  if(!quiet) {
    console.log("Running command: "+ command);
  }
  let retry = 0;
  let output = {};
  let success = false;

  if(!account) {
    account = accountStore[0];
  }

  let execOptions = {
    maxBuffer: 1024 * 1024 * 1024,
    env: { 
      ...process.env,
      'AWS_ACCESS_KEY_ID': account['credentials']['accessKeyId'],
      'AWS_SECRET_ACCESS_KEY': account['credentials']['secretAccessKey'],
      'AWS_DEFAULT_REGION': account['region']
    }
  };

  while(retry<6) {
    try {
      output = await exec(command,execOptions);
      if(!failString) {
        retry = 6;
        success = true;
      } else if(output.stdout.includes(failString)) {
        retry++;
        await sleep(retry*10000);
      } else {
        retry = 6;
        success = true;
      }
    } catch(e) {
      if(!quiet) {
        console.log(e);
      }
      if(successString) {
        if(e.stderr.includes(successString)) {
          retry = 6;
          success = true;
          output = e;
        }
      }
      if(e.stderr.includes("Unauthorized")) {
        console.log("Unauthorized.");
        process.exit(1);
      }
      if(!success) {
        retry++;
        await sleep(retry*10000);
      }
    }
  }
  if(output.stdout && !quiet) {
    console.log(output.stdout);
  } 
  if(output.stderr && !quiet) {
    console.log(output.stderr);
  }
  return output;
}

async function main() {
  let action = getParameters("action");
  let numClusters = parseInt(getParameters("numClusters"));
  let numAppsPerCluster = parseInt(getParameters("numAppsPerCluster"));
  let numNodes = parseInt(getParameters("numNodes"));
  let numReplicas = parseInt(getParameters("numReplicas"));
  let clusterStart = parseInt(getParameters("clusterStart"));
  let appName = getParameters("appName");
  let appRepo = getParameters("appRepo");
  let opProc = getParameters("opProc");
  let statProc = getParameters("statProc");
  let recTimeout = getParameters("recTimeout");
  let instanceType = getParameters("instanceType");
  let burstQPS = getParameters("burstQPS");
  let QPS = getParameters("QPS");
  let logLevel = getParameters("logLevel");
  let manifestUrl = getParameters("manifestUrl");
  let roleArn = getParameters("roleArn");
  let shardAlgorithm = getParameters("shardAlgorithm");
  if(!instanceType) {
    instanceType = "m5.large";
  }

  if(!action) {
    console.log("Missing required parameter.");
    process.exit(1);
  }

  if(action.match(/^(create|delete|createPostSteps|createNodeGroups|createClusters|deleteClusters|fixKubeContexts|deleteKubeContexts)$/)) {
    if(!numClusters) {
      console.log("Missing required parameter.");
      process.exit(1);
    }
    let contextArr = await getKubeContexts();
    let currentNumClusters = contextArr.length;
    if(clusterStart || clusterStart === 0) {
      currentNumClusters = clusterStart;
    }
    
    if(action.match(/^(delete|deleteClusters|deleteKubeContexts)$/)) {
      currentNumClusters = 0;
    } else {
      if(currentNumClusters > numClusters) {
        console.log("numClusters must be greater than current number of clusters with create action.");
        process.exit(1);
      }
    }

    console.time();
    let promiseArr = [];
    let errorFound = "";
    for(let i = currentNumClusters;i<numClusters;i++) {
      let account = getAcctFromClusterNum(i);
      let execOptions = {
        env: { 
          ...process.env,
          'AWS_ACCESS_KEY_ID': account['credentials']['accessKeyId'],
          'AWS_SECRET_ACCESS_KEY': account['credentials']['secretAccessKey'],
          'AWS_DEFAULT_REGION': account['region']
        }
      }
      if(action.match(/^(create|createClusters)$/)) {
        let checkCluster = await runCommand('aws cloudformation describe-stacks --stack-name eksctl-'+clusterPrefix+''+i+'-cluster',"","ValidationError",true,getAcctFromClusterNum(i));
        let stackError = false;
        if(checkCluster.stdout) {
          if((JSON.parse(checkCluster.stdout)).Stacks[0].StackStatus !== "CREATE_COMPLETE") {
            console.log("Cluster "+clusterPrefix+""+i+" is not healthy. Deleting the stack.");
            stackError = true;
            await runCommand('aws cloudformation delete-stack --stack-name eksctl-'+clusterPrefix+''+i+'-cluster',"","",true,getAcctFromClusterNum(i));
            let stackDeleted = false;
            while(!stackDeleted) {
              let checkStackDeleted = await runCommand('aws cloudformation describe-stacks --stack-name eksctl-'+clusterPrefix+''+i+'-cluster',"","ValidationError",true,getAcctFromClusterNum(i));
              if(checkStackDeleted.stderr.match(/ValidationError/)) {
                stackDeleted = true;
              }
              await sleep(5000);
            }
          }
        }
        if(checkCluster.stderr.match(/ValidationError/) || stackError) {
          console.log('Creating cluster '+clusterPrefix+''+i);
          let promise = exec('eksctl create cluster --name '+clusterPrefix+''+i+' --region '+account['region']+' --version 1.25 --vpc-private-subnets '+account['subnets'].join(',')+' --without-nodegroup',execOptions).catch((error)=> {
            console.log(clusterPrefix+""+i+":"+error);
            errorFound = "create";
          });
          promiseArr.push(promise);
          if(promiseArr.length > 50) {
            await Promise.all(promiseArr);
            promiseArr = [];
          }
        }
      } else if(action.match(/^(delete|deleteClusters)$/)) {
        console.log('Deleting cluster '+clusterPrefix+''+i);
        let promise = exec('eksctl delete --region='+account['region']+' cluster --name '+clusterPrefix+''+i,execOptions).catch((error)=> {
          console.log(clusterPrefix+""+i+":"+error);
          errorFound = "delete";
        });
        promiseArr.push(promise);
        if(promiseArr.length > 50) {
          await Promise.all(promiseArr);
          promiseArr = [];
        }
      }
    }
    await Promise.all(promiseArr);
    console.timeEnd();

    if(errorFound) {
      if(errorFound === "create") {
        console.log("Errors found on creation. Try running the command again with the following parameters: --action create --numClusters "+numClusters+" --clusterStart"+currentNumClusters);
      } else if(errorFound === "delete") {
        console.log("Errors found on deletion. Try running the command again.");
      }
      process.exit(1);
    }

    if(action.match(/^(create|fixKubeContexts|delete|deleteClusters|deleteKubeContexts)$/)) {
      let contextArr = await getKubeContexts();
      let account = getAcctFromClusterNum(0);
      for(let i=currentNumClusters;i<numClusters;i++) {
        if(contextArr[i]) {
          await runCommand('kubectl config delete-context '+contextArr[i]);
        }
        if(action.match(/^(create|fixKubeContexts)$/)) {
          await runCommand('aws eks update-kubeconfig --region="'+account['region']+'" --name="'+clusterPrefix+''+i+'" --alias="'+clusterPrefix+''+i+'"',"","",false,getAcctFromClusterNum(i));
        }
      }
    }

    console.time();
    promiseArr = [];
    contextArr = await getKubeContexts();
    for(let i = currentNumClusters;i<numClusters;i++) {
      let account = getAcctFromClusterNum(i);
      let execOptions = {
        env: { 
          ...process.env,
          'AWS_ACCESS_KEY_ID': account['credentials']['accessKeyId'],
          'AWS_SECRET_ACCESS_KEY': account['credentials']['secretAccessKey'],
          'AWS_DEFAULT_REGION': account['region']
        }
      }
      if(action.match(/^(create|createNodeGroups)$/)) {
        await runCommand('kubectl config use-context '+contextArr[i],"","",false,getAcctFromClusterNum(i));
        await runCommand('kubectl set env daemonset aws-node -n kube-system ENABLE_PREFIX_DELEGATION=true',"","",false,getAcctFromClusterNum(i));
        await runCommand('kubectl set env ds aws-node -n kube-system WARM_PREFIX_TARGET=1',"","",false,getAcctFromClusterNum(i));

        console.log('Creating nodegroups for '+clusterPrefix+''+i);
        if(!numNodes) {
          numNodes = 1;
        }
        if(i !== 0) {
          instanceType = "m5.large";
        }
        let promise = exec('eksctl create nodegroup --cluster '+clusterPrefix+''+i+' --name node-group-'+instanceType.replaceAll(".","")+' --node-type '+instanceType+' --node-ami-family AmazonLinux2 --nodes '+numNodes+' --subnet-ids '+account['subnets'].join(',')+' --node-private-networking --max-pods-per-node 110', execOptions).catch((error)=> {
          console.log(clusterPrefix+''+i+":"+error);
        });
        promiseArr.push(promise);
      }
    }
    await Promise.all(promiseArr);
    console.timeEnd();

    if(action.match(/^(create|createPostSteps)$/)) {
      if(currentNumClusters === 0) {
        console.log("Setting up Argo Cluster.");
        let contextArr = await getKubeContexts();
        let account = getAcctFromClusterNum(0);
        await runCommand('kubectl config use-context '+contextArr[0]);
        await runCommand('aws iam create-policy --policy-name AWSLoadBalancerControllerIAMPolicy --policy-document file://iam_policy.json',"","EntityAlreadyExists",true);
        await runCommand('eksctl utils associate-iam-oidc-provider --region='+account['region']+' --cluster='+clusterPrefix+'0 --approve');
        await runCommand('eksctl create iamserviceaccount --cluster='+clusterPrefix+'0 --namespace=kube-system --name=aws-load-balancer-controller --role-name=AmazonEKSLoadBalancerControllerRole --attach-policy-arn=arn:aws:iam::'+account['awsAccountNum']+':policy/AWSLoadBalancerControllerIAMPolicy --approve');
        await runCommand('eksctl create iamserviceaccount --cluster='+clusterPrefix+'0 --namespace=kube-system --name=ebs-csi-controller-sa  --role-name=AmazonEKS_EBS_CSI_DriverRole --attach-policy-arn=arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy --approve --role-only');
        await runCommand('eksctl create addon --name aws-ebs-csi-driver --cluster '+clusterPrefix+'0 --service-account-role-arn arn:aws:iam::'+account['awsAccountNum']+':role/AmazonEKS_EBS_CSI_DriverRole --force');
        await runCommand('helm repo add eks https://aws.github.io/eks-charts');
        await runCommand('helm repo add prometheus-community https://prometheus-community.github.io/helm-charts');
        await runCommand('helm repo update');
        await runCommand('helm install aws-load-balancer-controller eks/aws-load-balancer-controller -n kube-system --set clusterName='+clusterPrefix+'0 --set serviceAccount.create=false --set serviceAccount.name=aws-load-balancer-controller');
        await runCommand('kubectl create namespace prometheus');
        await runCommand('helm install prometheus-operator prometheus-community/kube-prometheus-stack -n prometheus');
        await runCommand('kubectl patch svc prometheus-operator-grafana -n prometheus -p "{\\"spec\\": {\\"type\\": \\"LoadBalancer\\"}}"');
      } else {
        let contextArr = await getKubeContexts();
        await runCommand('kubectl config use-context '+contextArr[0]);
        await loginArgoCD();
        for(let i = currentNumClusters;i<numClusters;i++) {
          console.log("Registering cluster "+clusterPrefix+""+i+" to argocd.");
          await runCommand('argocd cluster add '+contextArr[i],"","",false,getAcctFromClusterNum(i));
        }
      }
    }
  }

  if(action.match(/^(installArgo)$/)) {
    console.log("Installing argo on Argo Cluster.");
    let contextArr = await getKubeContexts();
    await runCommand('kubectl config use-context '+contextArr[0]);
    let checkNamespace = await runCommand('kubectl get namespace');
    if(!checkNamespace.stdout.match(/argocd/g)) {
      console.log("Namespace not found, creating namespace and deploying argocd.");
      await runCommand('kubectl create namespace argocd');
    }

    await runCommand('helm repo add argo https://argoproj.github.io/argo-helm');
    await runCommand('helm -f argocd_values.yaml install argocd argo/argo-cd -n argocd');
    await runCommand('kubectl wait pod -n argocd -l app.kubernetes.io/name=argocd-server --for=condition=ready --timeout=90s');
    await runCommand('kubectl apply -f argocd-dashboard.yaml -n prometheus');
    
    await loginArgoCD();

    for(let i = 1;i<contextArr.length;i++) {
      console.log("Registering cluster "+clusterPrefix+""+i+" to argocd.");
      await runCommand('argocd cluster add '+contextArr[i],"","",false,getAcctFromClusterNum(i));
    }
  }

  if(action.match(/^(installArgo|postInstallArgo)$/)) {
    let contextArr = await getKubeContexts();
    await runCommand('kubectl config use-context '+contextArr[0]);
    await runCommand('kubectl apply -f argocd-metrics.yaml -n argocd');
    await getDashboards();
  }

  if(action.match(/^(getDashboards)$/)) {
    let contextArr = await getKubeContexts();
    await runCommand('kubectl config use-context '+contextArr[0]);
    await getDashboards();
  }

  if(action.match(/^(scaleApps)$/)) {
    if(!numAppsPerCluster || !appName) {
      console.log("Missing required parameter.");
      process.exit(1);
    }

    let contextArr = await getKubeContexts();
    await runCommand('kubectl config use-context '+contextArr[0]);

    let clusterArr = await getClusterURLs();
    if(!numClusters) {
      numClusters = clusterArr.length;
    } else {
      numClusters = parseInt(numClusters);
      if(numClusters >= clusterArr.length) {
        numClusters = clusterArr.length;
      } else {
        numClusters += 1;
      }
    }

    await loginArgoCD();

    let argoApps = await getArgoApps(appName);

    console.time();
    let promiseArr = [];
    let errors = 0;
    for(let i=1;i<numClusters;i++) {
      if(!argoApps[i]) {
        argoApps[i] = [];
      }
      if(appRepo) {
        for(let y=0;y<numAppsPerCluster;y++) {
          if(!argoApps[i][y]) {
            let promise = exec('argocd app create cluster-'+i+'-'+appName+'-'+y+' --repo '+appRepo+' --path '+appName+' --dest-namespace cluster-'+i+'-'+appName+'-'+y+' --dest-server '+clusterArr[i]+' --directory-recurse --sync-policy auto --sync-option CreateNamespace=true').catch((error)=>{
              errors++;
            });
            promiseArr.push(promise);
            await sleep(300);
            if(promiseArr.length > 50) {
              await Promise.allSettled(promiseArr);
              promiseArr = [];
            }
          }
        }
        await Promise.allSettled(promiseArr);
        promiseArr = [];
      }
      if(numAppsPerCluster > argoApps[i].length) {
        if(!appRepo) {
          console.log("Missing required parameters: appRepo for scale up.");
          process.exit(1);
        }
        for(let y=argoApps[i].length;y<numAppsPerCluster;y++) {
          let promise = exec('argocd app create cluster-'+i+'-'+appName+'-'+y+' --repo '+appRepo+' --path '+appName+' --dest-namespace cluster-'+i+'-'+appName+'-'+y+' --dest-server '+clusterArr[i]+' --directory-recurse --sync-policy auto --sync-option CreateNamespace=true').catch((error)=>{
            console.log('Tried to run command: argocd app create cluster-'+i+'-'+appName+'-'+y+' --repo '+appRepo+' --path '+appName+' --dest-namespace cluster-'+i+'-'+appName+'-'+y+' --dest-server '+clusterArr[i]+' --directory-recurse --sync-policy auto --sync-option CreateNamespace=true');
            console.log(error.stderr);
            errors++;
          });
          promiseArr.push(promise);
          await sleep(300);
          if(promiseArr.length > 50) {
            await Promise.allSettled(promiseArr);
            promiseArr = [];
          }
        }
      } else if(numAppsPerCluster < argoApps[i].length) {
        for(let y=argoApps[i].length-1;y>numAppsPerCluster-1;y--) {
          let promise = exec('argocd app delete cluster-'+i+'-'+appName+'-'+y+' --yes').catch((error)=> {
            console.log(error.stderr);
          });
          promiseArr.push(promise);
          await sleep(300);
          if(promiseArr.length > 50) {
            await Promise.allSettled(promiseArr);
            promiseArr = [];
          }
        }
      }
    }
    await Promise.allSettled(promiseArr);
    console.timeEnd();
    console.log("Errors: "+errors);
  }

  if(action.match(/^(deleteAllApps)$/)) {
    if(!appName) {
      console.log("Missing required parameter.");
      process.exit(1);
    }
    let contextArr = await getKubeContexts();
    await runCommand('kubectl config use-context '+contextArr[0]);
    let clusterArr = await getClusterURLs();
    await loginArgoCD();

    let argoApps = await getArgoApps(appName);

    console.time();

    let promiseArr = [];
    for(let i in clusterArr) {
      if(!argoApps[i]) {
        argoApps[i] = [];
      }
      for(let y in argoApps[i]) {
        let promise = exec('argocd app delete '+argoApps[i][y]+' --yes').catch((error)=> {
          console.log(error.stderr);
        });
        promiseArr.push(promise);
        await sleep(200);
        if(promiseArr.length > 50) {
          await Promise.all(promiseArr);
          promiseArr = [];
        }
      }
    }
    await Promise.all(promiseArr);
    console.timeEnd();
  }

  if(action.match(/^(scaleArgoCluster)$/)) {
    if(!numNodes) {
      console.log("Missing required parameter.");
      process.exit(1);
    }
    let contextArr = await getKubeContexts();
    await runCommand('kubectl config use-context '+contextArr[0]);

    if(instanceType) {
      let oldNodeGroup = JSON.parse((await runCommand('eksctl get nodegroup --cluster '+clusterPrefix+'0 -o json',"","",true)).stdout)[0].Name;
      if(oldNodeGroup.split("-")[2] != instanceType) {
        let newNodeGroup = 'node-group-'+instanceType.replaceAll(".","");
        await runCommand('eksctl create nodegroup --cluster '+clusterPrefix+'0 --name '+newNodeGroup+' --node-type '+instanceType+' --node-ami-family AmazonLinux2 --nodes '+numNodes+' --subnet-ids '+accountStore[0]['subnets'].join(',')+' --node-private-networking --max-pods-per-node 110');
        await runCommand('kubectl wait node -l eks.amazonaws.com/nodegroup='+newNodeGroup+' --for=condition=ready --timeout=90s');
        await runCommand('eksctl delete nodegroup --cluster '+clusterPrefix+'0 --name '+oldNodeGroup);
      } else {
        await scaleNodes(numNodes,clusterPrefix+"0");
      }
    } else {
      await scaleNodes(numNodes,clusterPrefix+"0");
    }
  }

  if(action.match(/^(scaleAppClusters)$/)) {
    if(!numNodes) {
      console.log("Missing required parameter.");
      process.exit(1);
    }
    let contextArr = await getKubeContexts();

    for(let i=1;i<contextArr.length;i++) {
      await scaleNodes(numNodes,clusterPrefix+""+i);
    }
  }

  if(action.match(/^(scaleArgoController)$/)) {
    if(!numReplicas) {
      console.log("Missing required parameter.");
      process.exit(1);
    }
    let contextArr = await getKubeContexts();

    await runCommand('kubectl config use-context '+contextArr[0]);
    await scaleArgoController(numReplicas);
  }

  if(action.match(/^(scaleArgoServer)$/)) {
    if(!numReplicas) {
      console.log("Missing required parameter.");
      process.exit(1);
    }
    let contextArr = await getKubeContexts();
    await runCommand('kubectl config use-context '+contextArr[0]);

    await scaleArgoApiServer(numReplicas);
  }

  if(action.match(/^(scaleArgoRepoServer)$/)) {
    if(!numReplicas) {
      console.log("Missing required parameter.");
      process.exit(1);
    }
    let contextArr = await getKubeContexts();
    await runCommand('kubectl config use-context '+contextArr[0]);

    await scaleArgoRepoServer(numReplicas);
  }

  if(action.match(/^(loginArgo)$/)) {
    let contextArr = await getKubeContexts();
    await runCommand('kubectl config use-context '+contextArr[0]);
    await loginArgoCD();
  }

  if(action.match(/^(scalePrometheus)$/)) {
    if(!numReplicas) {
      console.log("Missing required parameter.");
      process.exit(1);
    }
    let contextArr = await getKubeContexts();
    await runCommand('kubectl config use-context '+contextArr[0]);
    await runCommand('kubectl patch prometheus prometheus-operator-kube-p-prometheus -n prometheus --type=merge -p "{\\"spec\\": {\\"replicas\\": '+numReplicas+'}}"');
  }

  if(action.match(/^(setArgoControllerQPS)$/)) {
    if(!burstQPS && !QPS) {
      console.log("Missing required parameter.");
      process.exit(1);
    }
    let contextArr = await getKubeContexts();
    await runCommand('kubectl config use-context '+contextArr[0]);
    if(burstQPS) {
      await runCommand('kubectl patch statefulset argocd-application-controller -n argocd -p "{\\"spec\\":{\\"template\\":{\\"spec\\":{\\"containers\\":[{\\"name\\": \\"application-controller\\", \\"env\\":[{\\"name\\":\\"ARGOCD_K8S_CLIENT_BURST\\",\\"value\\":\\"'+burstQPS+'\\"}]}]}}}}"');
    }
    if(QPS) {
      await runCommand('kubectl patch statefulset argocd-application-controller -n argocd -p "{\\"spec\\":{\\"template\\":{\\"spec\\":{\\"containers\\":[{\\"name\\": \\"application-controller\\", \\"env\\":[{\\"name\\":\\"ARGOCD_K8S_CLIENT_QPS\\",\\"value\\":\\"'+QPS+'\\"}]}]}}}}"');
    }
    await runCommand('kubectl rollout restart statefulset argocd-application-controller -n argocd');
  }

  if(action.match(/^(setArgoControllerProc)$/)) {
    if(!opProc && !statProc) {
      console.log("Missing required parameter.");
      process.exit(1);
    }
    let contextArr = await getKubeContexts();
    await runCommand('kubectl config use-context '+contextArr[0]);
    await runCommand('kubectl get configmap argocd-cmd-params-cm -n argocd -o json > argocd-cmd-params-cm.json',"","",true);
    let file = fs.readFileSync("argocd-cmd-params-cm.json");
    let json = JSON.parse(file.toString());
    try {
      if(opProc) {
        opProc = parseInt(opProc);
        if(json.data['controller.operation.processors'] != opProc) {
          console.log("Setting controller.operation.processors to "+opProc);
          json.data['controller.operation.processors'] = opProc.toString();
        }
      }
      if(statProc) {
        statProc = parseInt(statProc);
        if(json.data['controller.status.processors'] != statProc) {
          console.log("Setting controller.status.processors to "+statProc);
          json.data['controller.status.processors'] = statProc.toString();
        }
      }
    } catch(e){
      console.log(e);
      process.exit(1);
    }
    fs.writeFileSync("argocd-cmd-params-cm.json",JSON.stringify(json));
    await runCommand('kubectl apply -f argocd-cmd-params-cm.json -n argocd',"","",false);
    await runCommand('kubectl rollout restart statefulset argocd-application-controller -n argocd');
  }

  if(action.match(/^(setArgoControllerRecTimeout)$/)) {
    if(!recTimeout) {
      console.log("Missing required parameter.");
      process.exit(1);
    }
    let contextArr = await getKubeContexts();
    await runCommand('kubectl config use-context '+contextArr[0]);
    await runCommand('kubectl get configmap argocd-cm -n argocd -o json > argocd-cm.json',"","",true);
    let file = fs.readFileSync("argocd-cm.json");
    let json = JSON.parse(file.toString());
    try {
      if(recTimeout) {
        if(!recTimeout.match(/[0-9]+s/)) {
          console.log("Reconciliation timeout is not in the correct format.");
        }
        if(json.data['timeout.reconciliation'] != recTimeout) {
          console.log("Setting  to timeout.reconciliation to "+recTimeout);
          json.data['timeout.reconciliation'] = recTimeout;
        }
      }
    } catch(e){
      console.log(e);
      process.exit(1);
    }
    fs.writeFileSync("argocd-cm.json",JSON.stringify(json));
    await runCommand('kubectl apply -f argocd-cm.json -n argocd',"","",false);
    await runCommand('kubectl rollout restart statefulset argocd-application-controller -n argocd');
  }

  if(action.match(/^(setArgoControllerLogLevel)$/)) {
    if(!logLevel) {
      console.log("Missing required parameter.");
      process.exit(1);
    }
    if(!logLevel.match(/debug|info|warn|error/)) {
      console.log("Invalid loglevel.");
      process.exit(1);
    }
    let contextArr = await getKubeContexts();
    await runCommand('kubectl config use-context '+contextArr[0]);
    await runCommand('kubectl get configmap argocd-cmd-params-cm -n argocd -o json > argocd-cmd-params-cm.json',"","",true);
    let file = fs.readFileSync("argocd-cmd-params-cm.json");
    let json = JSON.parse(file.toString());
    try {
      
      if(json.data['controller.log.level'] != logLevel) {
        console.log("Setting controller.log.level to "+logLevel);
        json.data['controller.log.level'] = logLevel.toString();
      }
    } catch(e){
      console.log(e);
      process.exit(1);
    }
    fs.writeFileSync("argocd-cmd-params-cm.json",JSON.stringify(json));
    await runCommand('kubectl apply -f argocd-cmd-params-cm.json -n argocd',"","",false);
    await runCommand('kubectl rollout restart statefulset argocd-application-controller -n argocd');
  }

  if(action.match(/^(updateArgoCDVersion)$/)) {
    if(!manifestUrl) {
      console.log("Missing required parameter.");
      process.exit(1);
    }
    let contextArr = await getKubeContexts();
    await runCommand('kubectl config use-context '+contextArr[0]);
    await runCommand('kubectl apply -n argocd -f '+manifestUrl);
  }

  if(action.match(/^(restartAppController)$/)) {
    let contextArr = await getKubeContexts();
    await runCommand('kubectl config use-context '+contextArr[0]);
    await runCommand('kubectl rollout restart statefulset argocd-application-controller -n argocd');
  }

  if(action.match(/^(iamIdentityMapping)$/)) {
    if(!roleArn) {
      console.log("Missing required parameter.");
      process.exit(1);
    }
    let contextArr = await getKubeContexts();
    let account = getAcctFromClusterNum(0);
    await runCommand('kubectl config use-context '+contextArr[0]);
    await runCommand('eksctl create iamidentitymapping --cluster '+clusterPrefix+'0 --region '+account['region']+' --arn '+roleArn+' --group system:masters --no-duplicate-arns --username admin-user1');
  }

  if(action.match(/^(setArgoControllerShardAlgorithm)$/)) {
    if(!shardAlgorithm) {
      console.log("Missing required parameter.");
      process.exit(1);
    }
    let contextArr = await getKubeContexts();
    await runCommand('kubectl config use-context '+contextArr[0]);
    await setArgoControllerShardAlgorithm(shardAlgorithm);
  }
}

main();